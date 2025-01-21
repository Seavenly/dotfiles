local language_servers = {
    "lua_ls", "cssls", "eslint", "gopls", "html", "jsonls", "ts_ls", "pyright", "rust_analyzer",
    "svelte", "taplo", "yamlls", "zls"
}

return {
    "williamboman/mason-lspconfig.nvim",
    dependencies = {
        "neovim/nvim-lspconfig",                  -- neovim LSP
        { "williamboman/mason.nvim", opts = {} }, -- Mason LSP installer
        { 'j-hui/fidget.nvim',       opts = {} }, -- Useful status updates for LSP
        { 'folke/neodev.nvim',       opts = {} }, -- Additional lua configuration, makes nvim stuff amazing!
        "hrsh7th/cmp-nvim-lsp",                   -- lsp completions
        'nvim-telescope/telescope.nvim'
    },
    init = function()
        local signs = {
            { name = "DiagnosticSignError", text = "" },
            { name = "DiagnosticSignWarn", text = "" },
            { name = "DiagnosticSignHint", text = "" },
            { name = "DiagnosticSignInfo", text = "" },
        }

        for _, sign in ipairs(signs) do
            vim.fn.sign_define(sign.name, { texthl = sign.name, text = sign.text, numhl = "" })
        end

        local config = {
            -- disable virtual text
            virtual_text = false,
            -- virtual_text = {
            --   source = "always",
            --   prefix = "●",
            -- },
            -- show signs
            signs = {
                active = signs,
            },
            update_in_insert = false,
            underline = true,
            severity_sort = true,
            float = {
                focusable = false,
                style = "minimal",
                border = "rounded",
                source = "always",
                header = "",
                prefix = "",
            },
        }

        vim.diagnostic.config(config)

        vim.lsp.handlers["textDocument/hover"] = vim.lsp.with(vim.lsp.handlers.hover, {
            border = "rounded",
        })
        vim.lsp.handlers["textDocument/signatureHelp"] = vim.lsp.with(vim.lsp.handlers.signature_help, {
            border = "rounded",
        })

        vim.filetype.add {
            extension = {
                ["mdx"] = "markdown",
                ["hurl"] = "hurl",
                ["sh"] = "sh"
            },
            filename = {
                ["Fastfile"] = "ruby",
            },
        }
    end,
    config = function()
        local lspconfig = require "lspconfig"
        local mason_lspconfig = require "mason-lspconfig"
        local handlers = require "user.lsp.handlers"

        mason_lspconfig.setup {
            ensure_installed = language_servers
        }

        mason_lspconfig.setup_handlers {
            function(server_name)
                local lsp_opts = {
                    on_attach = handlers.on_attach,
                    capabilities = handlers.capabilities,
                }

                if server_name == "jsonls" then
                    local jsonls_opts = require("user.lsp.settings.jsonls")
                    lsp_opts = vim.tbl_deep_extend("force", jsonls_opts, lsp_opts)
                end

                lspconfig[server_name].setup(lsp_opts)
            end,
        }
    end
}
