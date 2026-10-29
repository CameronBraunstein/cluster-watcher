"""Tests for Slurm fair-share parsing and account-specific standing."""

from clusterwatcher.fair_share import (
    ACCOUNT_RULES_COMMAND, PARTITION_RULES_COMMAND, SSHARE_COMMAND,
    annotate_partition_access, parse_account_rules, parse_fair_share,
    parse_partition_rules, partition_associations,
)
from helpers import TimedTestCase


class FairShareTests(TimedTestCase):
    """Keep factor ranks scoped to valid, visible Slurm associations."""

    def test_multiple_accounts_and_ties(self):
        self.assertIn("sshare --all --Users --partition", SSHARE_COMMAND)
        self.assertIn("Account,User,Partition,FairShare", SSHARE_COMMAND)
        summary = parse_fair_share(
            "lab|alice|gpu_a100|0.750000\nother|bob|gpu_a100|0.900000\n"
            "project|alice|gpu_h100|0.900000\nteam|carol||0.500000\n",
            "alice",
        )

        self.assertEqual(summary["visible_associations"], 4)
        self.assertEqual(summary["associations"], [
            {"account": "project", "partition": "gpu_h100", "factor": 0.9, "rank": 1, "total": 4},
            {"account": "lab", "partition": "gpu_a100", "factor": 0.75, "rank": 3, "total": 4},
        ])
        self.assertIsNone(summary["error"])
        self.assertEqual(partition_associations(summary, "gpu_a100"), [summary["associations"][1]])
        self.assertEqual(partition_associations(summary, "apu"), [])

    def test_same_account_can_have_different_partition_factors(self):
        summary = parse_fair_share(
            "gpu_a100_bs_default|alice|gpu_a100|0.725\n"
            "gpu_a100_bs_default|alice|gpu_h100|0.250\n"
            "unscoped|alice||0.800\n",
            "alice",
        )

        self.assertEqual(summary["visible_associations"], 3)
        self.assertEqual(partition_associations(summary, "gpu_a100")[0]["factor"], 0.725)
        self.assertEqual(partition_associations(summary, "gpu_h100")[0]["factor"], 0.25)
        self.assertNotIn("unscoped", [entry["account"] for entry in partition_associations(summary, "gpu_a100")])

    def test_malformed_and_nonfinite_rows_do_not_become_ranks(self):
        summary = parse_fair_share(
            "Account|User|FairShare\nlab|alice|nan\n"
            "lab|bob|inf\nlab|carol|1.2\nlab|alice|0.250000|\n",
            "alice",
        )

        self.assertEqual(summary["visible_associations"], 1)
        self.assertEqual(summary["associations"][0]["rank"], 1)
        self.assertIsNone(summary["associations"][0]["partition"])
        self.assertEqual(parse_fair_share("lab|bob|0.5\n", "alice")["associations"], [])
        self.assertIn("not visible", parse_fair_share("lab|bob|0.5\n", "alice")["error"])

    def test_account_ancestry_and_partition_qos_map_unscoped_associations(self):
        """INF-style subaccounts map without guessing from their names."""
        self.assertIn("scontrol show partition --oneliner", PARTITION_RULES_COMMAND)
        self.assertIn("ParentName,QOS", ACCOUNT_RULES_COMMAND)
        partitions = parse_partition_rules(
            "PartitionName=gpu-v100 AllowGroups=ALL AllowAccounts=gpu_v100 "
            "AllowQos=interactive,gpu_v100 RootOnly=NO\n"
            "PartitionName=gpu-all AllowGroups=ALL AllowAccounts=gpu_all "
            "AllowQos=interactive,gpu_all RootOnly=NO\n"
            "PartitionName=restricted AllowGroups=special AllowAccounts=ALL AllowQos=ALL\n"
        )
        accounts = parse_account_rules(
            "infcluster|gpu_v100|||root|\n"
            "infcluster|gpu_v100_bs|||gpu_v100|\n"
            "infcluster|gpu_v100_bs_default|||gpu_v100_bs|\n"
            "infcluster|gpu_v100_bs_default|alice|||gpu_v100,interactive\n"
            "infcluster|gpu_v100_other_default|||gpu_v100|\n"
            "infcluster|gpu_v100_other_default|alice|||gpu_v100,interactive\n"
            "infcluster|gpu_all|||root|\n"
            "infcluster|gpu_all_bs_default|||gpu_all|\n"
            "infcluster|gpu_all_bs_default|alice|||gpu_all\n"
            "othercluster|gpu_v100_bs_default|alice|||gpu_v100\n",
            "infcluster", "alice",
        )
        share = parse_fair_share(
            "gpu_v100_bs_default|alice||0.998557\n"
            "gpu_v100_other_default|alice||0.983505\n"
            "gpu_all_bs_default|alice||0.773196\n",
            "alice",
        )

        mapped = annotate_partition_access(share, {"partitions": partitions, "accounts": accounts})

        self.assertEqual(
            {entry["account"] for entry in partition_associations(mapped, "gpu-v100")},
            {"gpu_v100_bs_default", "gpu_v100_other_default"},
        )
        self.assertEqual(
            {entry["account"] for entry in partition_associations(mapped, "gpu-all")},
            {"gpu_all_bs_default"},
        )
        self.assertEqual(partition_associations(mapped, "restricted"), [])
        self.assertTrue(all(entry["mapping_source"] == "account_qos"
                            for entry in partition_associations(mapped, "gpu-v100")))

    def test_missing_ancestry_or_qos_never_grants_access_by_name(self):
        partitions = parse_partition_rules(
            "PartitionName=gpu-v100 AllowGroups=ALL AllowAccounts=gpu_v100 AllowQos=gpu_v100\n"
        )
        share = parse_fair_share("gpu_v100_lookalike|alice||0.9\n", "alice")
        no_parent = {"parents": {}, "user_associations": [
            {"account": "gpu_v100_lookalike", "partition": None, "qos": ["gpu_v100"]},
        ]}
        no_qos = {"parents": {"gpu_v100_lookalike": "gpu_v100"}, "user_associations": [
            {"account": "gpu_v100_lookalike", "partition": None, "qos": ["other"]},
        ]}

        for accounts in (no_parent, no_qos):
            with self.subTest(accounts=accounts):
                mapped = annotate_partition_access(share, {"partitions": partitions, "accounts": accounts})
                self.assertEqual(partition_associations(mapped, "gpu-v100"), [])

        fallback = annotate_partition_access(share, {"error": "access rules unavailable"})
        self.assertEqual(fallback["mapping_error"], "access rules unavailable")
        self.assertEqual(partition_associations(fallback, "gpu-v100"), [])

    def test_account_denials_apply_when_allow_accounts_is_all(self):
        rules = {
            "partitions": parse_partition_rules(
                "PartitionName=shared AllowGroups=ALL AllowAccounts=ALL "
                "DenyAccounts=blocked AllowQOS=ALL DenyQOS=private\n"
            ),
            "accounts": {
                "parents": {"blocked_child": "blocked", "allowed": "root"},
                "user_associations": [
                    {"account": "blocked_child", "partition": None, "qos": ["normal"]},
                    {"account": "allowed", "partition": None, "qos": ["private", "normal"]},
                ],
            },
        }
        share = parse_fair_share(
            "blocked_child|alice||0.8\nallowed|alice||0.5\n", "alice",
        )

        mapped = annotate_partition_access(share, rules)

        self.assertEqual(
            [entry["account"] for entry in partition_associations(mapped, "shared")],
            ["allowed"],
        )
