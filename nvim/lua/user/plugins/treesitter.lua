return {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    main = "nvim-treesitter.configs",
    dependencies = { "OXY2DEV/markview.nvim" },
    lazy = false,
    opts = {
        ensure_installed = {
            "javascript", "lua", "rust", "bash", "comment", "css", "dockerfile", "go", "graphql",
            "html",
            "jsdoc", "json", "kotlin", "markdown", "markdown_inline", "python", "svelte", "scss", "swift", "toml",
            "typescript", "tsx",
            "vim",
            "yaml", "ruby", "hurl", "zig", "templ", "regex"
        },                       -- one of "all" or a list of languages
        sync_install = false,    -- install languages synchronously (only applied to `ensure_installed`)
        ignore_install = { "" }, -- List of parsers to ignore installing
        autopairs = {
            enable = true,
        },
        highlight = {
            enable = true,    -- false will disable the whole extension
            disable = { "" }, -- list of language that will be disabled
            additional_vim_regex_highlighting = true,
        },
        indent = { enable = false },
    },
}
