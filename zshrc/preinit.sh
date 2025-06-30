# Support opening nvim within lazygit
export EDITOR="nvr -l"
export VISUAL="nvr --remote-wait + 'set bufhidden=wipe'"

export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
 
export PATH="$PATH:$HOME/.pyenv/shims"
export PATH="$PATH:$HOME/.local/bin"
export PATH="$PATH:./node_modules/.bin"

if [[ $OSTYPE == darwin* ]]; then
    if ! which brew &> /dev/null; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        brew update
    fi
fi

if ! which mise &> /dev/null; then
    curl https://mise.run | sh
fi

# Setup zinit zsh plugin manager
ZINIT_HOME="$XDG_DATA_HOME/zinit/zinit.git"
if [ ! -d "$ZINIT_HOME" ]; then
    mkdir -p "$(dirname $ZINIT_HOME)"
    git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
fi
source "${ZINIT_HOME}/zinit.zsh"

# Setup oh my posh
if ! which oh-my-posh &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install oh-my-posh
    else
        curl -s https://ohmyposh.dev/install.sh | bash -s
    fi
fi
