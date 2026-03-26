return {
    "zk-org/zk-nvim",
    name = "zk",
    keys = {
        -- Navigation
        { '<leader>zo', "<Cmd>ZkNotes { sort = { 'modified' } }<CR>", desc = 'Open note',                  mode = 'n' },
        { '<leader>zo', ":'<,'>ZkMatch<CR>",                          desc = 'Find note from selection',   mode = 'v' },
        { '<leader>zt', "<Cmd>ZkTags<CR>",                            desc = 'Browse tags' },
        { '<leader>zb', "<Cmd>ZkBacklinks<CR>",                       desc = 'Backlinks' },
        { '<leader>zl', "<Cmd>ZkLinks<CR>",                           desc = 'Links' },
        -- Create Notes
        { '<leader>zn', "<Cmd>ZkNew<CR>",                             desc = 'New note',                   mode = 'n' },
        { '<leader>zn', "<Cmd>ZkNewFromTitleSelection<CR>",           desc = 'New note from selection',    mode = 'v' },
        -- Insert Links
        { '<leader>zi', "<Cmd>ZkInsertLink<CR>",                      desc = 'Insert link',                mode = 'n' },
        { '<leader>zi', "<Cmd>ZkInsertLinkAtSelection<CR>",           desc = 'Insert link from selection', mode = 'v' },
    },
    opts = {
        -- Can be "telescope", "fzf", "fzf_lua", "minipick", "snacks_picker",
        -- or select" (`vim.ui.select`).
        picker = "snacks_picker",

        lsp = {
            -- `config` is passed to `vim.lsp.start(config)`
            config = {
                name = "zk",
                cmd = { "zk", "lsp" },
                filetypes = { "markdown" },
                -- on_attach = ...
                -- etc, see `:h vim.lsp.start()`
            },

            -- automatically attach buffers in a zk notebook that match the given filetypes
            auto_attach = {
                enabled = true,
            },
        },
    },
}
