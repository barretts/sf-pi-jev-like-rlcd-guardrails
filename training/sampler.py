"""Frozen C11 pair coverage and group-balanced FIT sampling."""

from __future__ import annotations

import random
from typing import Any

class ShuffledCycle:
    def __init__(self, values: list[Any], rng: random.Random) -> None:
        if not values:
            raise ValueError("Balanced sampler has an empty group, family or label cell")
        self.values = list(values)
        self.rng = rng
        self.cursor = len(self.values)

    def draw(self) -> Any:
        if self.cursor == len(self.values):
            self.rng.shuffle(self.values)
            self.cursor = 0
        value = self.values[self.cursor]
        self.cursor += 1
        return value


class FitSampler:
    """Cover each explicit pair once, then balance indivisible pair groups.

    Pair and singleton draws alternate. Singleton draws retain the admitted label
    and family cycles. These structural checks do not admit authored FIT data.
    """

    def __init__(self, rows: list[dict[str, Any]], pairs: list[dict[str, Any]],
                 families: dict[str, str], seed: int = 42) -> None:
        self.rng = random.Random(seed)
        self.draws = 0
        self.pair_draws = 0
        self.counts: dict[str, int] = {}
        self.families = dict(families)
        source_groups = {row["source_id"]: row["group"] for row in rows}
        pair_by_group: dict[str, list[dict[str, Any]]] = {}
        pair_ids = set()
        units = []
        for pair in pairs:
            pair_id, group = pair.get("pair_id"), pair.get("group_id")
            safe, risky = pair["safe"], pair["risky"]
            if not isinstance(pair_id, str) or not pair_id or pair_id in pair_ids:
                raise ValueError("C11 FIT requires unique explicit pair IDs")
            if (not isinstance(group, str) or not group
                    or safe.get("group") != group or risky.get("group") != group
                    or source_groups.get(safe["source_id"]) != group
                    or source_groups.get(risky["source_id"]) != group):
                raise ValueError("C11 explicit pair must name FIT rows from its own group")
            if families[safe["source_id"]] != families[risky["source_id"]]:
                raise ValueError("C11 explicit pair crosses eligible families")
            pair_ids.add(pair_id)
            unit = {"kind": "pair", **pair}
            units.append(unit)
            pair_by_group.setdefault(group, []).append(unit)
        self.pair_count = len(units)
        self.coverage_items = ShuffledCycle(sorted(units, key=lambda unit: unit["pair_id"]), self.rng)
        self.pair_groups = ShuffledCycle(sorted(pair_by_group), self.rng)
        self.pair_items = {
            group: ShuffledCycle(sorted(items, key=lambda unit: unit["pair_id"]), self.rng)
            for group, items in pair_by_group.items()
        }
        row_by_label_family: dict[str, dict[str, list[dict[str, Any]]]] = {"allow": {}, "confirm": {}}
        for row in rows:
            label = "allow" if row["target_probabilities"] == [1, 0] else "confirm"
            family = families[row["source_id"]]
            row_by_label_family[label].setdefault(family, []).append({"kind": "single", "row": row})
        self.row_families = {
            label: ShuffledCycle(sorted(cells), self.rng)
            for label, cells in row_by_label_family.items()
        }
        self.row_items = {
            (label, family): ShuffledCycle(sorted(items, key=lambda unit: unit["row"]["source_id"]), self.rng)
            for label, cells in row_by_label_family.items() for family, items in cells.items()
        }

    def draw(self) -> dict[str, Any]:
        if self.draws % 2 == 0:
            if self.pair_draws < self.pair_count:
                unit = self.coverage_items.draw()
            else:
                group = self.pair_groups.draw()
                unit = self.pair_items[group].draw()
            self.pair_draws += 1
            key = f"pair:{self.families[unit['safe']['source_id']]}"
        else:
            label = ("allow", "confirm")[(self.draws // 2) % 2]
            family = self.row_families[label].draw()
            unit = self.row_items[(label, family)].draw()
            key = f"row:{label}:{family}"
        self.draws += 1
        self.counts[key] = self.counts.get(key, 0) + 1
        return unit
