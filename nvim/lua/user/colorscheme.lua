-- vim.g.tokyonight_style="night"

-- vim.cmd [[
-- try
--   colorscheme kanagawa
-- catch /^Vim\%((\a\+)\)\=:E185/
--   colorscheme default
--   set background=dark
-- endtry
-- ]]

-- Default options:
require('kanagawa').setup({
    undercurl = true, -- enable undercurls
    commentStyle = { italic = true },
    functionStyle = {},
    keywordStyle = { italic = true },
    statementStyle = { bold = true },
    typeStyle = {},
    variablebuiltinStyle = { italic = true },
    specialReturn = true, -- special highlight for the return keyword
    specialException = true, -- special highlight for exception handling keywords
    transparent = false, -- do not set background color
    dimInactive = false, -- dim inactive window `:h hl-NormalNC`
    globalStatus = false, -- adjust window separators highlight for laststatus=3
    terminalColors = true, -- define vim.g.terminal_color_{0,17}
    colors = {},
    overrides = {},
    theme = "default" -- Load "default" theme or the experimental "light" theme
})

-- setup must be called before loading
vim.cmd("colorscheme tokyonight") -- Not sure why this fixes svelte files
vim.cmd("colorscheme kanagawa")
