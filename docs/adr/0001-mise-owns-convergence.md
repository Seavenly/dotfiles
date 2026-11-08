# Mise owns convergence

Native mise bootstrap is the declarative owner of tools, packages,
repositories, preferences, and configuration links. Repository shell code may
validate the host, migrate legacy layouts, or warm derived state, but it must
not grow a competing package or symlink engine; this keeps one convergence
model and one cross-platform lockfile.
