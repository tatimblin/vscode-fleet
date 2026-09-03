The controls editor is a custom editor bound to a zero-byte `controls.vehicle`
file. Commands take 600–900 ms and can fail.

The rejections are derived from state, not dice: the vehicle doing 100 km/h
refuses with `IN_MOTION`, the sleeping one is unreachable, and the one in
Stage with its driver's door ajar refuses with `DOOR_OPEN`. Try the one that
is driving first — a demo where everything succeeds is a demo that is not
simulating anything.
