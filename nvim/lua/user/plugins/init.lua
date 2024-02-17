return {
    -- Helper Utils
    "nvim-lua/popup.nvim",   -- An implementation of the Popup API from vim in Neovim
    "nvim-lua/plenary.nvim", -- Useful lua functions used ny lots of plugins

    "numToStr/Comment.nvim", -- Easily comment stuff
    "moll/vim-bbye",
    { "akinsho/toggleterm.nvim", branch = "main" },
    "ahmedkhalf/project.nvim",
    "lewis6991/impatient.nvim",
    "lukas-reineke/indent-blankline.nvim",
    "goolord/alpha-nvim",
    "antoinemadec/FixCursorHold.nvim", -- This is needed to fix lsp doc highlight
    "folke/which-key.nvim",
    "karb94/neoscroll.nvim",

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
}
