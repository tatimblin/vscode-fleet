An OTA campaign against one vehicle: download, verify, flash six named ECUs,
reboot. Cancellable at every stage, and the installed version is untouched if
you cancel.

Preconditions are checked first and are the interesting part. A vehicle in D
reports `shifterLeverNotInPark`, one below 20% reports low battery, and a
sleeping one is simply unreachable. Watch `state.json` while it runs.
