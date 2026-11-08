# Keep machine-local configuration outside Git

Identity, secrets, host-specific aliases, and local paths live under
`~/.config/dotfiles/` rather than in tracked templates with committed values.
Convergence may create secure empty/default files, but the host remains the
owner of their contents so the repository can be shared safely.
