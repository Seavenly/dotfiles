vim.pack.add({ { src = 'https://github.com/zk-org/zk-nvim', name = 'zk' } })

require('zk').setup({
    picker = "snacks_picker",
    lsp = {
        config = {
            name = "zk",
            cmd = { "zk", "lsp" },
            filetypes = { "markdown" },
        },
        auto_attach = {
            enabled = true,
        },
    },
})

require('user.utils').set_keys({
    { '<leader>zo', "<Cmd>ZkNotes { sort = { 'modified' } }<CR>", desc = 'Open note',                  mode = 'n' },
    { '<leader>zo', ":'<,'>ZkMatch<CR>",                          desc = 'Find note from selection',   mode = 'v' },
    { '<leader>zt', "<Cmd>ZkTags<CR>",                            desc = 'Browse tags' },
    { '<leader>zb', "<Cmd>ZkBacklinks<CR>",                       desc = 'Backlinks' },
    { '<leader>zl', "<Cmd>ZkLinks<CR>",                           desc = 'Links' },
    { '<leader>zn', "<Cmd>ZkNew<CR>",                             desc = 'New note',                   mode = 'n' },
    { '<leader>zn', "<Cmd>ZkNewFromTitleSelection<CR>",           desc = 'New note from selection',    mode = 'v' },
    { '<leader>zi', "<Cmd>ZkInsertLink<CR>",                      desc = 'Insert link',                mode = 'n' },
    { '<leader>zi', "<Cmd>ZkInsertLinkAtSelection<CR>",           desc = 'Insert link from selection', mode = 'v' },
}, { silent = true })
