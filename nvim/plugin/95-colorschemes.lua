vim.pack.add({
    'https://github.com/catppuccin/nvim',
    'https://github.com/sainnhe/everforest',
    'https://github.com/sainnhe/gruvbox-material',
    'https://github.com/rebelot/kanagawa.nvim',
    'https://github.com/rose-pine/neovim',
})

require('kanagawa').setup({
    compile = false,
    undercurl = true,
    commentStyle = { italic = true },
    functionStyle = {},
    keywordStyle = { italic = true },
    statementStyle = { bold = true },
    typeStyle = {},
    dimInactive = false,
    terminalColors = true,
    colors = {
        palette = {},
        theme = {
            wave = {},
            lotus = {},
            dragon = {},
            all = {
                ui = {
                    bg_gutter = "none",
                },
            },
        },
    },
    overrides = function(colors)
        return {}
    end,
    theme = "wave",
    background = {
        dark = "wave",
        light = "lotus",
    },
})

require('rose-pine').setup({
    styles = {
        transparency = true,
    },
})

-- Default fallback. Shada-restored colors_name will override this post-startup
-- if the user picked a different scheme last session via <leader>uC.
pcall(vim.cmd.colorscheme, 'rose-pine-moon')
