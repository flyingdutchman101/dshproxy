# Responsive pass: what is kept here

- `results.txt`: the layout program's result for each of the 231 captures of the final build (seven checks per capture: equal margins, every control inside its parent, text fits, no horizontal scrollbar, no overlap, columns sum to the list width, scroll range). 1617 of 1617 passed.
- `results-before-fixes.txt` and `results-before-last-round.txt`: the same program on earlier sources (1009 of 1272, then 1615 of 1617).
- `backdrop-in-pictures.txt`, `last-round-picture-comparison.txt`: picture comparisons between runs.

The 231 pictures themselves are not in the repository. The window's bottom line shows the data and program folders, which on the machine that took them lie under the local user profile; this repository is public. They can be taken again with `../app-status-and-memory/harness/layout.ps1`, which builds the app from the sources and captures every page at every size off screen.

In the text files here and in `../app-status-and-memory/`, the local profile folder was replaced by `%USERPROFILE%` after the runs. Nothing else in them was edited.