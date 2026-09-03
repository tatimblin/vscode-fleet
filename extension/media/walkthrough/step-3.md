A pseudoterminal rendering ~1,200 frames/sec down to a readable ten lines.
Signal-bearing frames are decoded inline; the rest is filler, because a real
bus is mostly traffic you are not looking for.

`p` pauses, `f` hides the filler, `c` clears, `q` closes. Pause it and decode
a `DI_speed` frame by hand — 12|12@1+, factor 0.08, offset −40 — and you will
get the speed the controls editor is showing.
