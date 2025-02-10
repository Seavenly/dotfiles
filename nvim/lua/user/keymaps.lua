local utils = require 'user.utils'

--Remap space as leader key
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

local keys = {
    { '<Space>',     '<Nop>',                   desc = 'Space character noop',                      mode = { 'n', 'v' } },
    -- Window navigation
    { '<C-Left>',    '<C-w>h',                  desc = 'Navigate to window left' },
    { '<C-Down>',    '<C-w>j',                  desc = 'Navigate to window down' },
    { '<C-Up>',      '<C-w>k',                  desc = 'Navigate to window up' },
    { '<C-Right>',   '<C-w>l',                  desc = 'Navigate to window right' },
    -- Buffer navigation
    { 'L',           ':bnext<CR>',              desc = 'Navigate to next buffer' },
    { 'H',           ':bprevious<CR>',          desc = 'Navigate to previous buffer' },
    { '<S-Right>',   ':bnext<CR>',              desc = 'Navigate to next buffer' },
    { '<S-Left>',    ':bprevious<CR>',          desc = 'Navigate to previous buffer' },
    -- Window resize
    { '<A-C-Up>',    ':resize -2<CR>',          desc = 'Resize window up' },
    { '<A-C-Down>',  ':resize +2<CR>',          desc = 'Resize window down' },
    { '<A-C-Left>',  ':vertical resize +2<CR>', desc = 'Resize window left' },
    { '<A-C-Right>', ':vertical resize -2<CR>', desc = 'Resize window right' },
    -- Scrolling
    { '<C-u>',       '<C-u>zz',                 desc = 'Scroll half-page up and center on cursor' },
    { '<C-d>',       '<C-d>zz',                 desc = 'Scroll half-page down and center on cursor' },
    -- Move text up and down
    { '<A-k>',       '<Esc>:m .-2<CR>==gi',     desc = 'Move line up and enter insert mode' },
    { '<A-j>',       '<Esc>:m .+1<CR>==gi',     desc = 'Move line down and enter insert mode' },
    { '<A-j>',       ':m .+1<CR>==',            desc = 'Move line down',                            mode = 'v' },
    { '<A-k>',       ':m .-2<CR>==',            desc = 'Move line up',                              mode = 'v' },
    { '<A-j>',       ':move \'>+1<CR>gv-gv',    desc = 'Move line down',                            mode = 'x' },
    { '<A-k>',       ':move \'<-2<CR>gv-gv',    desc = 'Move line up',                              mode = 'x' },
    { '<A-Up>',      '<Esc>:m .-2<CR>==gi',     desc = 'Move line up and enter insert mode' },
    { '<A-Down>',    '<Esc>:m .+1<CR>==gi',     desc = 'Move line down and enter insert mode' },
    { '<A-Down>',    ':m .+1<CR>==',            desc = 'Move line down',                            mode = 'v' },
    { '<A-Up>',      ':m .-2<CR>==',            desc = 'Move line up',                              mode = 'v' },
    { '<A-Down>',    ':move \'>+1<CR>gv-gv',    desc = 'Move line down',                            mode = 'x' },
    { '<A-Up>',      ':move \'<-2<CR>gv-gv',    desc = 'Move line up',                              mode = 'x' },
    -- Stay in indent mode
    { '<',           '<gv',                     desc = 'Indent right and keep selection',           mode = 'v' },
    { '>',           '>gv',                     desc = 'Indent left and keep selection',            mode = 'v' },
    -- Other
    { 'p',           '"_dP',                    desc = 'Paste and keep previous yank on clipboard', mode = 'v' },
    -- Global leader commands
    { '<leader>w',   ':w!<CR>',                 desc = 'Save' },
    { '<leader>h',   ':nohlsearch<CR>',         desc = 'No Highlight' },
}

utils.set_keys(keys, { silent = true })
