import collections
import copy
import unittest

from sampler import FitSampler


def fixture():
    rows, pairs, families = [], [], {}
    for group, family, size in (("group-a", "shell", 1),
                                ("group-b", "shell", 2),
                                ("group-c", "agentscript", 5)):
        for index in range(size):
            safe = {"source_id": f"{group}-{index}-safe", "group": group,
                    "target_probabilities": [1, 0]}
            risky = {"source_id": f"{group}-{index}-risky", "group": group,
                     "target_probabilities": [0, 1]}
            rows.extend((safe, risky))
            families.update({safe["source_id"]: family, risky["source_id"]: family})
            pairs.append({"pair_id": f"{group}-{index}", "group_id": group,
                          "safe": safe, "risky": risky})
    for label, target in (("allow", [1, 0]), ("confirm", [0, 1])):
        row = {"source_id": f"singleton-only-{label}", "group": "singleton-group",
               "target_probabilities": target}
        rows.append(row)
        families[row["source_id"]] = "apex"
    return rows, pairs, families


def identity(unit):
    return (unit["kind"], unit["pair_id"] if unit["kind"] == "pair"
            else unit["row"]["source_id"])


class FitSamplerTests(unittest.TestCase):
    def test_one_finite_coverage_pass_then_group_cycles(self):
        rows, pairs, families = fixture()
        sampler = FitSampler(rows, pairs, families)
        units = [sampler.draw() for _ in range(2 * (len(pairs) + 3 * 10))]
        pair_units = units[::2]
        self.assertEqual(collections.Counter(unit["pair_id"] for unit in pair_units[:len(pairs)]),
                         collections.Counter(pair["pair_id"] for pair in pairs))
        ongoing = pair_units[len(pairs):]
        groups = {pair["group_id"] for pair in pairs}
        counts = collections.Counter({group: 0 for group in groups})
        for unit in ongoing:
            counts[unit["group_id"]] += 1
            self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)
        for start in range(0, len(ongoing), len(groups)):
            self.assertEqual({unit["group_id"] for unit in ongoing[start:start + len(groups)]}, groups)
        for group in groups:
            expected = {pair["pair_id"] for pair in pairs if pair["group_id"] == group}
            local = [unit["pair_id"] for unit in ongoing if unit["group_id"] == group]
            for start in range(0, len(local) - len(expected) + 1, len(expected)):
                self.assertEqual(set(local[start:start + len(expected)]), expected)
        self.assertEqual(counts, {group: 10 for group in groups})

    def test_repeated_variants_do_not_multiply_ongoing_group_weight(self):
        rows, pairs, families = fixture()
        sampler = FitSampler(rows, pairs, families)
        for _ in range(2 * len(pairs)):
            sampler.draw()
        ongoing = [sampler.draw() for _ in range(600)]
        group_counts = collections.Counter(unit["group_id"] for unit in ongoing if unit["kind"] == "pair")
        self.assertEqual(group_counts, {"group-a": 100, "group-b": 100, "group-c": 100})
        family_counts = collections.Counter(families[unit["safe"]["source_id"]]
                                           for unit in ongoing if unit["kind"] == "pair")
        self.assertEqual(family_counts, {"shell": 200, "agentscript": 100})
        pair_counts = collections.Counter(unit["pair_id"] for unit in ongoing if unit["kind"] == "pair")
        self.assertEqual(pair_counts["group-a-0"], 100)
        self.assertEqual(pair_counts["group-b-0"], 50)
        self.assertTrue(all(pair_counts[f"group-c-{index}"] == 20 for index in range(5)))

    def test_exact_schedule_singleton_labels_families_and_item_cycles(self):
        rows, pairs, families = fixture()
        sampler = FitSampler(rows, pairs, families)
        units = [sampler.draw() for _ in range(2048)]
        self.assertEqual([unit["kind"] for unit in units], ["pair", "single"] * 1024)
        singles = units[1::2]
        labels = ["allow" if unit["row"]["target_probabilities"] == [1, 0] else "confirm"
                  for unit in singles]
        self.assertEqual(labels, ["allow", "confirm"] * 512)
        for label in ("allow", "confirm"):
            local = [unit for unit, actual in zip(singles, labels) if actual == label]
            counts = collections.Counter(families[unit["row"]["source_id"]] for unit in local)
            self.assertEqual(set(counts), {"shell", "agentscript", "apex"})
            self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)
            for family in counts:
                expected = {row["source_id"] for row in rows if families[row["source_id"]] == family
                            and row["target_probabilities"] == ([1, 0] if label == "allow" else [0, 1])}
                item_ids = [unit["row"]["source_id"] for unit in local
                            if families[unit["row"]["source_id"]] == family]
                for start in range(0, len(item_ids) - len(expected) + 1, len(expected)):
                    self.assertEqual(set(item_ids[start:start + len(expected)]), expected)
        self.assertEqual(sum(sampler.counts.values()), sampler.draws)
        self.assertEqual(sampler.pair_draws, 1024)

    def test_seed_input_order_and_input_immutability(self):
        rows, pairs, families = fixture()
        before = copy.deepcopy((rows, pairs, families))
        first = FitSampler(rows, pairs, families, 42)
        same = FitSampler(list(reversed(rows)), list(reversed(pairs)),
                             dict(reversed(list(families.items()))), 42)
        other = FitSampler(rows, pairs, families, 43)
        left = [identity(first.draw()) for _ in range(2048)]
        self.assertEqual(left, [identity(same.draw()) for _ in range(2048)])
        self.assertNotEqual(left, [identity(other.draw()) for _ in range(2048)])
        self.assertEqual((rows, pairs, families), before)

    def test_one_group_can_contain_individually_same_family_pairs_from_two_families(self):
        rows, pairs, families = fixture()
        for row in rows:
            if row["group"] == "group-b":
                row["group"] = "group-a"
        for pair in pairs:
            if pair["group_id"] == "group-b":
                pair["group_id"] = "group-a"
                families[pair["safe"]["source_id"]] = "herdr_pane"
                families[pair["risky"]["source_id"]] = "herdr_pane"
        sampler = FitSampler(rows, pairs, families)
        for _ in range(2 * len(pairs)):
            sampler.draw()
        units = [sampler.draw() for _ in range(400)]
        self.assertEqual(collections.Counter(unit["group_id"] for unit in units if unit["kind"] == "pair"),
                         {"group-a": 100, "group-c": 100})

    def test_reject_invalid_pair_groups_ids_and_cross_family_pairs(self):
        rows, pairs, families = fixture()
        def forged_group(values):
            values[0]["group_id"] = "invented-group"
            values[0]["safe"]["group"] = "invented-group"
            values[0]["risky"]["group"] = "invented-group"
        changes = [lambda values: values[0].update(group_id=""),
                   lambda values: values[0].update(group_id="unknown-group"),
                   lambda values: values[0].pop("group_id"),
                   lambda values: values[0]["safe"].update(group="group-b"),
                   lambda values: values[0]["risky"].update(group="group-b"),
                   lambda values: values[0]["safe"].pop("group"),
                   lambda values: values[0]["safe"].update(source_id="missing-fit-row"),
                   lambda values: values[0].update(pair_id=values[1]["pair_id"]),
                   forged_group]
        for change in changes:
            with self.subTest(change=change):
                changed = copy.deepcopy(pairs)
                change(changed)
                with self.assertRaises(ValueError):
                    FitSampler(rows, changed, families)
        changed_families = dict(families)
        changed_families[pairs[0]["risky"]["source_id"]] = "browser"
        with self.assertRaises(ValueError):
            FitSampler(rows, pairs, changed_families)
        with self.assertRaises(ValueError):
            FitSampler(rows, [], families)


if __name__ == "__main__":
    unittest.main()
