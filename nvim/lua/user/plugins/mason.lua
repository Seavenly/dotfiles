local language_servers = {
    "lua_ls", "cssls", "eslint", "gopls", "html", "jsonls", "ts_ls", "pyright", "rust_analyzer",
    "svelte", "taplo", "yamlls", "zls"
}

return {
    "williamboman/mason-lspconfig.nvim",
    dependencies = {
        "neovim/nvim-lspconfig",                  -- neovim LSP
        { "williamboman/mason.nvim", opts = {} }, -- Mason LSP installer
        'saghen/blink.cmp'
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
            virtual_text = false,
            -- virtual_text = {
            --   source = "always",
            --   prefix = "●",
            -- },
            -- show signs in status column
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
        local trouble = require "trouble"
        local utils = require "user.utils"


        local trouble_toggle = function(mode)
            return function()
                trouble.toggle({ mode = mode, auto_jump = false })

                if trouble.is_open(mode) then
                    trouble.focus()
                    trouble.first()
                end
            end
        end

        local on_attach = function(client, bufnr)
            local keys = {
                -- Diagnostics keymaps
                { '[d',         function() vim.diagnostic.goto_prev({ border = 'rounded' }) end,                 desc = 'Go to previous diagnostic message' },
                { ']d',         function() vim.diagnostic.goto_next({ border = 'rounded' }) end,                 desc = 'Go to next diagnostic message' },
                { '<leader>k',  function() vim.diagnostic.open_float({ border = 'rounded', source = true }) end, desc = 'Open floating diagnostic message' },
                { '<leader>lr', vim.lsp.buf.rename,                                                              desc = 'LSP: Rename' },
                { '<leader>la', vim.lsp.buf.code_action,                                                         desc = 'LSP: Code Actions' },
                { '<leader>ld', trouble_toggle('document_diagnostics'),                                          desc = 'LSP: Document Diagnostics' },
                { '<leader>lD', trouble_toggle('workspace_diagnostics'),                                         desc = 'LSP: Workspace Diagnostics' },
                -- Non-leader keymaps
                { 'gd',         function() trouble.toggle('lsp_definitions') end,                                desc = 'Goto Definition' },
                { 'gD',         vim.lsp.buf.declaration,                                                         desc = 'Goto Declaration' },
                { 'gr',         trouble_toggle('lsp_references'),                                                desc = 'Goto References' },
                { 'gi',         trouble_toggle('lsp_implementations'),                                           desc = 'Goto Implementations' },
                { 'gt',         trouble_toggle('lsp_type_definitions'),                                          desc = 'Goto Type Definition' },
                -- Hover
                { 'K',          vim.lsp.buf.hover,                                                               desc = 'Hover documentation' },
                { '<C-k>',      vim.lsp.buf.signature_help,                                                      desc = 'Signature documentation' }
            }

            utils.set_keys(keys, { buffer = bufnr, silent = true })
        end
        local capabilities = (function()
            local blink = require 'blink.cmp'
            local default_capabilities = vim.lsp.protocol.make_client_capabilities()

            -- Extend built-in LSP capabilities with blink.cmp
            return blink.get_lsp_capabilities(default_capabilities)
        end)()

        mason_lspconfig.setup {
            automatic_installation = false,
            ensure_installed = language_servers
        }

        mason_lspconfig.setup_handlers {
            function(server_name)
                local lsp_opts = {
                    on_attach = on_attach,
                    capabilities = capabilities,
                }

                if server_name == "jsonls" then
                    local jsonls_opts = require("user.lsp..jsonls")
                    lsp_opts = vim.tbl_deep_extend("force", jsonls_opts, lsp_opts)
                end

                lspconfig[server_name].setup(lsp_opts)
            end,
        }
    end
}
