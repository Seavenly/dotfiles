alias ls='eza --icons=auto --group-directories-first'
alias ll='eza --icons=auto --group-directories-first --long --git'
alias la='eza --icons=auto --group-directories-first --long --git --all'
alias tree='eza --icons=auto --tree'
alias cat='bat'

export FZF_DEFAULT_OPTS="--preview 'bat --color=always --style=numbers --line-range=:500 {} 2>/dev/null || eza --tree --level=2 --color=always {} 2>/dev/null'"
