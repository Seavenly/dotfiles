source "$HOME/.dotfiles/zshrc/preinit.sh"

# zinit plugins
zinit light zsh-users/zsh-syntax-highlighting
zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions

# Autodoad completions
autoload -Uz compinit && compinit
zinit cdreplay -q

# History
HISTSIZE=5000
HISTFILE=~/.zsh_history
SAVEHIST=$HISTSIZE
HISTUP=erase
setopt appendhistory
setopt sharehistory
setopt hist_ignore_space
setopt hist_ignore_all_dups
setopt hist_save_no_dups
setopt hist_ignore_dups
setopt hist_find_no_dups

# Load color into LS_COLORS var
eval "$(dircolors)"
# Completion styling
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' menu select

# Keymaps
bindkey '^[[Z' reverse-menu-complete
bindkey -s '^a' "~/.dotfiles/scripts/tmux-sessionizer.sh\n"

source "$HOME/.dotfiles/scripts/tmux-nvim-remote.sh"
source "$HOME/.dotfiles/zshrc/aliases.sh"

eval "$(oh-my-posh init zsh --config $HOME/.dotfiles/zshrc/onehalf.minimal.omp.yaml)"
eval "$(~/.local/bin/mise activate zsh)"
