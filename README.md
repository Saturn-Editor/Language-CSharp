# C# for Saturn

A Saturn language module for C# files (`.cs`, `.csx`).

## Features

- **Syntax colouring** for keywords, types, methods, attributes, comments (including XML doc comments),
  preprocessor directives, numbers and every string form: regular, verbatim (`@"…"`), interpolated (`$"…{x}"`)
  and raw (`"""…"""`, `$$"""…{{x}}"""`). The scope name is `source.cs`, so ` ```csharp ` blocks in the
  Markdown module use these colours too.
- **Completion** without needing the .NET SDK:
  - keywords, built-in types, locals and parameters, and members of the enclosing type
  - types and namespaces declared anywhere in the project, plus common .NET types
  - members after `.` for project types and common .NET types (`Console.`, `File.`, `List<T>`, `string`, LINQ, …),
    following simple chains like `order.Customer.Name.` and inferring `var`, `foreach` and lambda variables
  - namespaces after `using`, attributes inside `[…]`, and preprocessor directives after `#`
  - plain-text snippets: `ctor`, `prop`, `cw`, `svm`, `fore`, `fori`, `tryc`
- **File templates** for a class, interface, record and enum. The namespace comes from the nearest
  `.csproj` (its `RootNamespace`, or its file name) plus the folders in between. Projects that target .NET 6
  or later get file-scoped namespaces.
- **New C# project**: a console app or class library for .NET 10, 9 or 8, with an optional `.gitignore`.
- **Solution Explorer** panel, laid out like Visual Studio's: solution → solution folders → projects →
  Dependencies (frameworks, packages, project references) → folders → files → classes → nested classes and
  members. It reads `.sln` and `.slnx` solutions, falling back to the projects (or, with no project, the
  folder). Files nest the way Visual Studio nests them: `DependentUpon`, `Form1.Designer.cs` and `Form1.resx`
  under `Form1.cs`, `Index.cshtml.cs` under `Index.cshtml`, `appsettings.Development.json` under
  `appsettings.json`, `site.min.css` under `site.css`. Clicking a member opens the file at that line, and the
  tree refreshes when files change.
- **Open Project File** command, which opens the root `.csproj` (or else the `.slnx`/`.sln`).

Completion is heuristic: it reads the source with a lexer and pattern matching, not the Roslyn compiler.
Expect it to miss inherited .NET members, extension methods outside LINQ, and types that the code never
spells out.

## Installing

In Saturn, open **Marketplace → Languages → Install from folder…** and choose this folder.
No build or install step is needed; Saturn runs the completion server with its bundled runtime.

Requires Saturn module API `0.1`.

## Layout

| Path | Purpose |
| --- | --- |
| `saturn-module.json` | Manifest: what the module contributes |
| `module.js` | Registers the Solution Explorer, file templates, commands and new-project handler |
| `lib/csharp.js` | Lexer, outline (types and members) and local-variable discovery |
| `lib/solution.js` | `.sln`/`.slnx`/`.csproj` reading and Visual Studio file-nesting rules |
| `lib/explorer.js` | Solution Explorer tree provider |
| `lib/bcl.js` | A curated slice of the .NET class library used for member completion |
| `grammars/csharp.tmLanguage.json` | TextMate grammar for syntax colouring |
| `server/server.js` | Language server (completion) over stdio |

## Releasing

Bump `version` in `saturn-module.json` and push to `main`. The release workflow zips the tracked files
and publishes `csharp-<version>.zip` as a GitHub release.
