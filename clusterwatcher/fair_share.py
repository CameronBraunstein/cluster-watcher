"""Collect and summarize a user's account-specific Slurm fair-share standing.

The factor belongs to a user association (user, account, and optionally
partition), not inherently to an entire cluster or one partition. Ranks here
cover only associations returned by ``sshare --all``; site visibility rules
can make that set incomplete.
"""

import math
import re


# Never let an accounting/controller stall delay the rest of the dashboard.
# Slurm clusters targeted by this application are Linux systems with coreutils.
SSHARE_COMMAND = "timeout 5s sshare --all --Users --partition --noheader --parsable2 --format=Account,User,Partition,FairShare"
FAIR_SHARE_REFRESH_SECONDS = 600
PARTITION_RULES_COMMAND = "timeout 10s scontrol show partition --oneliner"
ACCOUNT_RULES_COMMAND = (
    "timeout 10s sacctmgr -n -P show assoc "
    "format=Cluster,Account,User,Partition,ParentName,QOS"
)


def _names(value: str) -> list[str]:
    """Split a Slurm comma-separated access list, preserving ``ALL``."""
    return [name.strip() for name in value.split(",") if name.strip()]


def parse_partition_rules(output: str) -> dict[str, dict[str, object]]:
    """Read partition account/QOS restrictions from ``scontrol --oneliner``.

    A missing access field is unknown, rather than an implicit ``ALL``: that
    prevents a truncated or site-specific response from granting false access.
    """
    rules: dict[str, dict[str, object]] = {}
    for line in output.splitlines():
        values = {key.lower(): value for key, value in re.findall(r"\b([A-Za-z]+)=([^\s]+)", line)}
        name = values.get("partitionname")
        if not name:
            continue
        rules[name] = {
            "allow_accounts": _names(values["allowaccounts"]) if "allowaccounts" in values else None,
            "deny_accounts": _names(values.get("denyaccounts", "")),
            "allow_qos": _names(values["allowqos"]) if "allowqos" in values else None,
            "deny_qos": _names(values.get("denyqos", "")),
            "allow_groups": values.get("allowgroups"),
            "root_only": values.get("rootonly", "NO").upper() == "YES",
        }
    return rules


def parse_account_rules(output: str, cluster: str, username: str) -> dict[str, object]:
    """Read account ancestry and this user's QOS from ``sacctmgr`` rows.

    Account rows have an empty User column and provide ``ParentName``; user
    rows provide effective QOS and an optional association partition. Rows
    belonging to another Slurm cluster are never mixed into these rules.
    """
    parents: dict[str, str | None] = {}
    user_associations: list[dict[str, object]] = []
    for line in output.splitlines():
        fields = line.strip().split("|")
        if len(fields) != 6:
            continue
        row_cluster, account, user, partition, parent, qos = (field.strip() for field in fields)
        if row_cluster != cluster or not account:
            continue
        if not user:
            parents[account] = parent or None
        elif user == username:
            user_associations.append({
                "account": account,
                "partition": partition or None,
                "qos": _names(qos),
            })
    return {"parents": parents, "user_associations": user_associations}


def _in_account_tree(account: str, ancestor: str, parents: dict[str, str | None]) -> bool:
    """Test ancestry without relying on account-name prefixes or looping on bad data."""
    seen: set[str] = set()
    current: str | None = account
    while current and current not in seen:
        if current == ancestor:
            return True
        seen.add(current)
        current = parents.get(current)
    return False


def _account_allowed(account: str, rule: dict[str, object], parents: dict[str, str | None]) -> bool:
    """Apply hierarchical AllowAccounts/DenyAccounts with Slurm precedence."""
    allowed = rule["allow_accounts"]
    if allowed is None:
        return False
    if "ALL" not in allowed:
        return any(_in_account_tree(account, name, parents) for name in allowed)
    return not any(_in_account_tree(account, name, parents) for name in rule["deny_accounts"])


def _qos_allowed(qos: list[str], rule: dict[str, object]) -> bool:
    """Require a known QOS permitted by both association and partition."""
    if not qos or rule["allow_qos"] is None:
        return False
    usable = set(qos) - set(rule["deny_qos"])
    return bool(usable) if "ALL" in rule["allow_qos"] else bool(usable & set(rule["allow_qos"]))


def annotate_partition_access(share: dict[str, object] | None, rules: dict[str, object] | None) -> dict[str, object] | None:
    """Add justified partition matches to current fair-share associations.

    Explicit association partitions remain usable when rules are unavailable.
    An unscoped association is mapped only when its account descends from an
    allowed parent and its effective QOS intersects the partition's QOS list.
    This is access-rule evidence, not a guarantee of a job's admission or start.
    """
    if share is None:
        return None
    result = {**share, "associations": []}
    if rules and rules.get("error"):
        result["mapping_error"] = rules["error"]
    partition_rules = (rules or {}).get("partitions", {})
    account_rules = (rules or {}).get("accounts", {})
    parents = account_rules.get("parents", {})
    user_associations = account_rules.get("user_associations", [])
    for entry in share.get("associations", []):
        explicit = entry.get("partition")
        matches = [explicit] if explicit else []
        if not explicit:
            relevant = [row for row in user_associations
                        if row["account"] == entry["account"] and row["partition"] is None]
            for partition, rule in partition_rules.items():
                if rule["root_only"] or rule["allow_groups"] != "ALL":
                    continue
                if _account_allowed(entry["account"], rule, parents) and any(
                    _qos_allowed(row["qos"], rule) for row in relevant
                ):
                    matches.append(partition)
        result["associations"].append({
            **entry,
            "matched_partitions": sorted(set(matches)),
            "mapping_source": "association" if explicit else "account_qos" if matches else None,
        })
    return result


def parse_fair_share(output: str, username: str) -> dict[str, object]:
    """Rank the user's associations by Slurm's fair-share factor.

    Higher factors are better. Equal factors share a competition rank; a
    factor printed with insufficient precision can therefore produce ties.
    Malformed rows and non-finite factors are ignored instead of entering the
    public status payload.
    """
    factors: dict[tuple[str, str, str | None], float] = {}
    for line in output.splitlines():
        fields = line.strip().rstrip("|").split("|")
        if len(fields) == 4:
            account, user, partition, raw_factor = (field.strip() for field in fields)
            partition = partition or None
        elif len(fields) == 3:
            # Older test fixtures and Slurm output without --partition have
            # no trustworthy partition relationship.
            account, user, raw_factor = (field.strip() for field in fields)
            partition = None
        else:
            continue
        if not account or not user:
            continue
        try:
            factor = float(raw_factor)
        except ValueError:
            continue
        if not math.isfinite(factor) or not 0 <= factor <= 1:
            continue
        factors[(account, user, partition)] = factor

    total = len(factors)
    own = [
        {"account": account, "partition": partition, "factor": factor,
         "rank": 1 + sum(other > factor for other in factors.values()), "total": total}
        for (account, user, partition), factor in factors.items() if user == username
    ]
    own.sort(key=lambda entry: (entry["rank"], entry["account"], entry["partition"] or ""))
    return {
        "associations": own,
        "visible_associations": total,
        "error": None if own else "Your fair-share association is not visible in sshare output.",
    }


def partition_associations(share: dict[str, object] | None, partition: str) -> list[dict[str, object]]:
    """Return associations mapped to this partition by explicit or access rules.

    Legacy data without ``matched_partitions`` retains explicit-only behavior.
    """
    associations = (share or {}).get("associations", [])
    return [entry for entry in associations if partition in entry.get(
        "matched_partitions", [entry.get("partition")],
    )]
