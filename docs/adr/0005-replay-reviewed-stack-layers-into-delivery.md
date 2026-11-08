# Replay reviewed stack layers into delivery

Agent Flow assembles reviewed stack layers by deterministically replaying each
owning-layer commit onto `epic/delivery` in order. Disposable topology tests
must continue proving merge-commit, squash, and replay assembly reach the exact
source tree, but replay is the production policy because it makes each applied
delta explicit, supports suffix restacking into new refs, and does not require
force-pushing a reviewed prefix. Every generation remains bound to immutable
source and target SHAs. Target drift invalidates approval before another ref or
PR mutation. This rejects implicit rebases, force-updating reviewed branches,
and treating commit identity as the delivery invariant; exact tree equality and
full verification are the invariant.

An approved stack plan remains immutable. A review edit may create a new active
stack generation only after a separate human approval fingerprints the changed
head, owning layer, original plan, and monotonically newer generation. The edit
must stay within the owning layer's exact hunks, the
unchanged prefix and new suffix reconstruct from Git, and full verification
passes. Publication and delivery consume that promoted chain plus canonical
review-manifest digests selected through the tuicr registry with intact event
evidence; they do not reinterpret the original plan or accept a caller-selected
approval document.
