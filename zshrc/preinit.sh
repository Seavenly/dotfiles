# Support opening nvim within lazygit
export EDITOR="nvr -l"
export VISUAL="nvr --remote-wait + 'set bufhidden=wipe'"

export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
 
export PATH="$PATH:/usr/local/go/bin"
export PATH="$PATH:$HOME/.pyenv/shims"
export PATH="$PATH:$HOME/.local/bin"

if [[ $OSTYPE == darwin* ]]; then
    if ! which brew &> /dev/null; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        brew update
    fi
fi

# Setup zinit zsh plugin manager
ZINIT_HOME="$XDG_DATA_HOME/zinit/zinit.git"
if [ ! -d "$ZINIT_HOME" ]; then
    mkdir -p "$(dirname $ZINIT_HOME)"
    git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
fi
source "${ZINIT_HOME}/zinit.zsh"

# Setup fnm and node
export PATH="$PATH:./node_modules/.bin"
export PATH="$PATH:$XDG_DATA_HOME/fnm"
if ! which fnm &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install fnm
    else
        curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
    fi
    fnm install --lts
fi

# Setup oh my posh
if ! which oh-my-posh &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install jandedobbeleer/oh-my-posh/oh-my-posh
    else
        curl -s https://ohmyposh.dev/install.sh | bash -s
    fi
fi

# Setup lazygit and delta
if ! which lazygit &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install lazygit git-delta
    else
        LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | \grep -Po '"tag_name": *"v\K[^"]*')
        curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_arm64.tar.gz"
        tar xf lazygit.tar.gz lazygit
        sudo install lazygit -D -t /usr/local/bin/
        rm lazygit.tar.gz lazygit

        curl -Lo git-delta_arm64.deb "https://github.com/dandavison/delta/releases/download/3.18.2/git-delta_0.18.2_arm64.deb"
        sudo dpkg -i git-delta_arm64.deb
        rm git-delta_arm64.deb
    fi
fi

if ! which rustup &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install rustup
    else
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    fi
fi

if !which tree-sitter &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install tree-sitter
    else
        cargo install --locked tree-sitter-cli
    fi
fi

if ! which nvim &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install neovim
    else
        sudo apt install cmake
        mkdir -p $HOME/dev/
        cd $HOME/dev/
        git clone https://github.com/neovim/neovim
        cd neovim
        git checkout stable
        make CMAKE_BUILD_TYPE=RelWithDebInfo
        sudo make install
        cd $HOME
    fi
fi

if ! which pip &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        # TODO
    else
        sudo apt install python3-pip
    fi
fi

if ! which go &> /dev/null; then
    if [[ $OSTYPE == darwin* ]]; then
        brew install go
    else
        # TODO
    fi
fi

# Use homebrew version of ruby if installed
if [ -d "/opt/homebrew/opt/ruby/bin" ]; then
  export PATH="$PATH:/opt/homebrew/opt/ruby/bin"
  export PATH="$PATH:`gem environment gemdir`/bin"
fi
if [ -d "/usr/local/opt/ruby/bin" ]; then
  export PATH="$PATH:/usr/local/opt/ruby/bin"
  export PATH="$PATH:`gem environment gemdir`/bin"
fi
