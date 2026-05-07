vim.pack.add({
    'https://github.com/rafamadriz/friendly-snippets',
    { src = 'https://github.com/saghen/blink.cmp', version = vim.version.range('*') },
})

require('blink.cmp').setup({
    keymap = {
        preset = 'default',
    },
    appearance = {
        use_nvim_cmp_as_default = true,
        nerd_font_variant = 'mono',
    },
    completion = {
        keyword = {
            range = 'full',
        },
        documentation = {
            auto_show = true,
            auto_show_delay_ms = 500,
            window = {
                border = 'rounded',
            },
        },
        ghost_text = {
            enabled = true,
        },
        menu = {
            border = 'none',
            draw = {
                columns = {
                    { "kind_icon", "label", "label_description", gap = 1 },
                    { "kind",      gap = 1 },
                },
                treesitter = { 'lsp' },
            },
        },
    },
    signature = {
        enabled = true,
        window = {
            border = 'rounded',
            winblend = 100,
        },
        trigger = {
            show_on_insert = true,
        },
    },
    cmdline = {
        keymap = { preset = 'inherit' },
        completion = { menu = { auto_show = true } },
    },
    sources = {
        default = { 'lsp', 'path', 'snippets', 'buffer' },
        -- Scope lazydev to Lua buffers via per_filetype so blink doesn't
        -- require('lazydev.integrations.blink') on non-Lua buffers (the
        -- provider's `enabled` field is checked AFTER the require). The plugin
        -- is lazy-loaded by 86-lazydev.lua on FileType=lua, which fires before
        -- InsertEnter so the module is available when blink needs it.
        per_filetype = {
            lua = { 'lazydev', inherit_defaults = true },
        },
        providers = {
            lazydev = {
                name = "LazyDev",
                module = "lazydev.integrations.blink",
                score_offset = 100,
            },
        },
    },
})
