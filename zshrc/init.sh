
# Support opening nvim within lazygit
export EDITOR="nvr -l"
export VISUAL="nvr --remote-wait + 'set bufhidden=wipe'"
# Used by lazygit
export XDG_CONFIG_HOME="$HOME/.config"

eval "$(fnm env --use-on-cd)"
# export NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
# [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# Add local node_modules bin to path
export PATH="$PATH:./node_modules/.bin"
export PATH="${HOME}/.pyenv/shims:${PATH}"

# Start tmux with a specific project session
bindkey -s '^a' "~/.dotfiles/scripts/tmux-sessionizer.sh\n"

source ~/.dotfiles/scripts/tmux-nvim-remote.sh
