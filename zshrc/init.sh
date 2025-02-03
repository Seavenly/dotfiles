
# Support opening nvim within lazygit
export EDITOR="nvr -l"
export VISUAL="nvr --remote-wait + 'set bufhidden=wipe'"
# Used by lazygit
export XDG_CONFIG_HOME="$HOME/.config"

# Add local node_modules bin to path
export PATH="$PATH:./node_modules/.bin"
export PATH="$HOME/.pyenv/shims:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# Use homebrew version of ruby if installed
if [ -d "/opt/homebrew/opt/ruby/bin" ]; then
  export PATH=/opt/homebrew/opt/ruby/bin:$PATH
  export PATH=`gem environment gemdir`/bin:$PATH
fi
if [ -d "/usr/local/opt/ruby/bin" ]; then
  export PATH=/usr/local/opt/ruby/bin:$PATH
  export PATH=`gem environment gemdir`/bin:$PATH
fi

# Start tmux with a specific project session
bindkey -s '^a' "~/.dotfiles/scripts/tmux-sessionizer.sh\n"

source ~/.dotfiles/scripts/tmux-nvim-remote.sh

alias serve="http-server . --ssl --cert ~/.ssh/localhost/localhost.cer.pem --key ~/.ssh/localhost/localhost.key.pem"
alias hurlenv="source ~/dev/hurl/scripts/set-hurl-env.sh"
