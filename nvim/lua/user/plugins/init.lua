return {
    -- Helper Utils
    "nvim-lua/popup.nvim",   -- An implementation of the Popup API from vim in Neovim
    "nvim-lua/plenary.nvim", -- Useful lua functions used ny lots of plugins
    "famiu/bufdelete.nvim",  -- Adds :Bdelete command

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

    -- Git
    "lewis6991/gitsigns.nvim",

    -- Training
    "ThePrimeagen/vim-be-good",
}
