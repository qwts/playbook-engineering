# Big doc

This document is sized to sit inside its budget override: larger than the repo default, smaller than the override, and close enough to the override that the bank-the-win branch stays quiet.

Budgeting prose by estimated tokens rather than by lines keeps the measurement aligned with what a reader model actually pays. A table can be short in lines and expensive in tokens, while a sparse checklist can be long in lines and cheap in tokens, so the line count is a poor stand-in for cost.

The ratchet direction matters as much as the ceiling. A ceiling that can drift upward without an argument is not a ceiling, it is a suggestion, and suggestions do not survive contact with deadline pressure. Recording the reason next to the number is what turns the number into a commitment.

The final property worth stating is determinism. A budget check that produces different results on different machines trains everyone to rerun it until it passes, which is another way of saying it trains everyone to ignore it. Every input to this computation is a file in the repository, so every result is reproducible from a checkout alone, with no network access and no model calls involved anywhere. Reproducibility is what lets a reviewer trust a red result enough to act on it immediately.
