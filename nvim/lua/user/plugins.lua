-- Automatically install lazy.nvim package manager
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
    vim.fn.system({
        "git",
        "clone",
        "--filter=blob:none",
        "https://github.com/folke/lazy.nvim.git",
        "--branch=stable", -- latest stable release
        lazypath,
    })
end
vim.opt.rtp:prepend(lazypath)

-- Use a protected call so we don't error out on first use
local status_ok, lazy = pcall(require, "lazy")
if not status_ok then
    return
end

-- Install your plugins here
lazy.setup({
    -- My plugins here
    "nvim-lua/popup.nvim",   -- An implementation of the Popup API from vim in Neovim
    "nvim-lua/plenary.nvim", -- Useful lua functions used ny lots of plugins
    "windwp/nvim-autopairs", -- Autopairs, integrates with both cmp and treesitter
    "numToStr/Comment.nvim", -- Easily comment stuff
    "kyazdani42/nvim-web-devicons",
    "kyazdani42/nvim-tree.lua",
    { "akinsho/bufferline.nvim", branch = "main" },
    "moll/vim-bbye",
    "nvim-lualine/lualine.nvim",
    { "akinsho/toggleterm.nvim", branch = "main" },
    "ahmedkhalf/project.nvim",
    "lewis6991/impatient.nvim",
    "lukas-reineke/indent-blankline.nvim",
    "goolord/alpha-nvim",
    "antoinemadec/FixCursorHold.nvim", -- This is needed to fix lsp doc highlight
    "folke/which-key.nvim",
    "karb94/neoscroll.nvim",

    -- Colorschemes
    -- "lunarvim/colorschemes", -- A bunch of colorschemes you can try out
    "lunarvim/darkplus.nvim",
    "pineapplegiant/spaceduck",
    "folke/tokyonight.nvim",
    "rebelot/kanagawa.nvim",

    -- cmp plugins
    "hrsh7th/nvim-cmp",         -- The completion plugin
    "hrsh7th/cmp-buffer",       -- buffer completions
    "hrsh7th/cmp-path",         -- path completions
    "hrsh7th/cmp-cmdline",      -- cmdline completions
    "saadparwaiz1/cmp_luasnip", -- snippet completions
    "hrsh7th/cmp-nvim-lsp",

    -- snippets
    "L3MON4D3/LuaSnip",             --snippet engine
    "rafamadriz/friendly-snippets", -- a bunch of snippets to use

    -- LSP
    "williamboman/mason.nvim",
    "williamboman/mason-lspconfig.nvim",
    "neovim/nvim-lspconfig",           -- enable LSP
    "tamago324/nlsp-settings.nvim",    -- language server settings defined in json for
    "jose-elias-alvarez/null-ls.nvim", -- for formatters and linters
    "folke/trouble.nvim",

    -- Telescope
    "nvim-telescope/telescope.nvim",

    -- Treesitter
    {
        "nvim-treesitter/nvim-treesitter",
        build = ":TSUpdate",
    },
    'nvim-treesitter/nvim-treesitter-context',
    "JoosepAlviste/nvim-ts-context-commentstring",

    -- Git
    "lewis6991/gitsigns.nvim",

    -- Training
    "ThePrimeagen/vim-be-good",
})
