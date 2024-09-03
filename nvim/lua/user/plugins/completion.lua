local has_words_before = function()
    unpack = unpack or table.unpack
    local line, col = unpack(vim.api.nvim_win_get_cursor(0))
    return col ~= 0 and vim.api.nvim_buf_get_lines(0, line - 1, line, true)[1]:sub(col, col):match("%s") == nil
end

local kind_icons = {
    -- Array         = " ",
    -- Boolean       = "󰨙 ",
    -- Class         = " ",
    -- Codeium       = "󰘦 ",
    -- Color         = " ",
    -- Control       = " ",
    -- Collapsed     = " ",
    -- Constant      = "󰏿 ",
    -- Constructor   = " ",
    -- Copilot       = " ",
    -- Enum          = " ",
    -- EnumMember    = " ",
    -- Event         = " ",
    -- Field         = " ",
    -- File          = " ",
    -- Folder        = " ",
    -- Function      = "󰊕 ",
    -- Interface     = " ",
    -- Key           = " ",
    -- Keyword       = " ",
    -- Method        = "󰊕 ",
    -- Module        = " ",
    -- Namespace     = "󰦮 ",
    -- Null          = " ",
    -- Number        = "󰎠 ",
    -- Object        = " ",
    -- Operator      = " ",
    -- Package       = " ",
    -- Property      = " ",
    -- Reference     = " ",
    -- Snippet       = " ",
    -- String        = " ",
    -- Struct        = "󰆼 ",
    -- TabNine       = "󰏚 ",
    -- Text          = " ",
    -- TypeParameter = " ",
    -- Unit          = " ",
    -- Value         = " ",
    -- Variable      = "󰀫 ",
    Text = "󰉿",
    Method = "󰆧",
    Function = "󰊕",
    Constructor = "",
    Field = " ",
    Variable = "󰀫",
    Class = "󰠱",
    Interface = "",
    Module = "",
    Property = "󰜢",
    Unit = "󰑭",
    Value = "󰎠",
    Enum = "",
    Keyword = "󰌋",
    Snippet = "",
    Color = "󰏘",
    File = "󰈙",
    Reference = "",
    Folder = "󰉋",
    EnumMember = "",
    Constant = "󰏿",
    Struct = "",
    Event = "",
    Operator = "󰆕",
    TypeParameter = " ",
    Misc = " ",
}

return {
    "hrsh7th/nvim-cmp",                 -- The completion plugin
    dependencies = {
        "hrsh7th/cmp-buffer",           -- buffer completions
        "hrsh7th/cmp-path",             -- path completions
        "hrsh7th/cmp-cmdline",          -- cmdline completions
        "hrsh7th/cmp-nvim-lsp",         -- lsp completions
        "saadparwaiz1/cmp_luasnip",     -- snippet completions

        "L3MON4D3/LuaSnip",             --snippet engine
        "rafamadriz/friendly-snippets", -- a bunch of snippets to use
    },
    config = function()
        local cmp = require "cmp"
        local luasnip = require "luasnip"

        require("luasnip/loaders/from_vscode").lazy_load()

        cmp.setup({
            snippet = {
                expand = function(args)
                    luasnip.lsp_expand(args.body) -- For `luasnip` users.
                end,
            },
            mapping = {
                ["<C-k>"] = cmp.mapping.select_prev_item(),
                ["<C-j>"] = cmp.mapping.select_next_item(),
                ["<C-b>"] = cmp.mapping(cmp.mapping.scroll_docs(-1), { "i", "c" }),
                ["<C-f>"] = cmp.mapping(cmp.mapping.scroll_docs(1), { "i", "c" }),
                ["<C-Space>"] = cmp.mapping(cmp.mapping.complete(), { "i", "c" }),
                ["<C-y>"] = cmp.config.disable, -- Specify `cmp.config.disable` if you want to remove the default `<C-y>` mapping.
                ["<C-e>"] = cmp.mapping {
                    i = cmp.mapping.abort(),
                    c = cmp.mapping.close(),
                },
                -- Accept currently selected item. If none selected, `select` first item.
                -- Set `select` to `false` to only confirm explicitly selected items.
                ["<CR>"] = cmp.mapping.confirm { select = true },
                ["<Tab>"] = cmp.mapping(function(fallback)
                    if cmp.visible() then
                        cmp.select_next_item()
                    elseif luasnip.expand_or_jumpable() then
                        luasnip.expand_or_jump()
                    elseif has_words_before() then
                        cmp.complete()
                    else
                        fallback()
                    end
                end, {
                    "i",
                    "s",
                }),
                ["<S-Tab>"] = cmp.mapping(function(fallback)
                    if cmp.visible() then
                        cmp.select_prev_item()
                    elseif luasnip.jumpable(-1) then
                        luasnip.jump(-1)
                    else
                        fallback()
                    end
                end, {
                    "i",
                    "s",
                }),
            },
            formatting = {
                fields = { "kind", "abbr", "menu" },
                format = function(entry, vim_item)
                    -- Kind icons
                    vim_item.kind = string.format("%s", kind_icons[vim_item.kind])
                    -- vim_item.kind = string.format('%s %s', kind_icons[vim_item.kind], vim_item.kind) -- This concatonates the icons with the name of the item kind
                    vim_item.menu = ({
                        nvim_lsp = "[LSP]",
                        luasnip = "[Snippet]",
                        buffer = "[Buffer]",
                        path = "[Path]",
                    })[entry.source.name]
                    return vim_item
                end,
            },
            sources = {
                { name = "nvim_lsp" },
                { name = "luasnip" },
                { name = "buffer" },
                { name = "path" },
            },
            confirm_opts = {
                behavior = cmp.ConfirmBehavior.Replace,
                select = false,
            },
            window = {
                documentation = cmp.config.window.bordered(),
            },
            -- documentation = {
            --   border = { "╭", "─", "╮", "│", "╯", "─", "╰", "│" },
            --},
            experimental = {
                ghost_text = false,
                native_menu = false,
            },
        })

        cmp.setup.cmdline({ '/', '?' }, {
            mapping = cmp.mapping.preset.cmdline(),
            sources = {
                { name = 'buffer' }
            }
        })

        cmp.setup.cmdline(':', {
            mapping = cmp.mapping.preset.cmdline(),
            sources = cmp.config.sources({
                { name = 'path' }
            }, {
                { name = 'cmdline' }
            })
        })
    end

}
