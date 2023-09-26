local status_ok, configs = pcall(require, "nvim-treesitter.configs")
if not status_ok then
    return
end

local status_ok, context = pcall(require, "treesitter-context")
if not status_ok then
    return
end

configs.setup {
    ensure_installed = { "javascript", "lua", "rust", "bash", "comment", "css", "dockerfile", "go", "graphql", "html",
        "jsdoc", "json", "kotlin", "markdown", "python", "svelte", "scss", "swift", "toml", "typescript", "tsx", "vim",
        "yaml", "ruby" },    -- one of "all" or a list of languages
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
    indent = { enable = true, disable = { "yaml" } },
    context_commentstring = {
        enable = true,
        enable_autocmd = false,
    },
}

context.setup {
    enable = true,            -- Enable this plugin (Can be enabled/disabled later via commands)
    max_lines = 0,            -- How many lines the window should span. Values <= 0 mean no limit.
    min_window_height = 0,    -- Minimum editor window height to enable context. Values <= 0 mean no limit.
    line_numbers = true,
    multiline_threshold = 20, -- Maximum number of lines to collapse for a single context line
    trim_scope = 'outer',     -- Which context lines to discard if `max_lines` is exceeded. Choices: 'inner', 'outer'
    mode = 'cursor',          -- Line used to calculate context. Choices: 'cursor', 'topline'
    -- Separator between context and content. Should be a single character string, like '-'.
    -- When separator is set, the context will only show up when there are at least 2 lines above cursorline.
    separator = nil,
    zindex = 20, -- The Z-index of the context window
}
