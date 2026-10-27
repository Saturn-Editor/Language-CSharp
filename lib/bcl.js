/**
 * A small slice of the .NET base class library for completion without a compiler.
 * Members are written "Name(params): ReturnType" for methods and "Name: Type" for properties/fields.
 */

const ENUMERABLE = [
  'Where(Func<T, bool> predicate): IEnumerable<T>', 'Select(Func<T, TResult> selector): IEnumerable<TResult>',
  'SelectMany(Func<T, IEnumerable<TResult>> selector): IEnumerable<TResult>', 'OrderBy(Func<T, TKey> keySelector): IOrderedEnumerable<T>',
  'OrderByDescending(Func<T, TKey> keySelector): IOrderedEnumerable<T>', 'GroupBy(Func<T, TKey> keySelector): IEnumerable<IGrouping<TKey, T>>',
  'First(): T', 'FirstOrDefault(): T?', 'Last(): T', 'LastOrDefault(): T?', 'Single(): T', 'SingleOrDefault(): T?',
  'Any(): bool', 'All(Func<T, bool> predicate): bool', 'Count(): int', 'Sum(): int', 'Min(): T', 'Max(): T', 'Average(): double',
  'Distinct(): IEnumerable<T>', 'Skip(int count): IEnumerable<T>', 'Take(int count): IEnumerable<T>', 'Reverse(): IEnumerable<T>',
  'Concat(IEnumerable<T> second): IEnumerable<T>', 'Zip(IEnumerable<TSecond> second): IEnumerable<(T, TSecond)>',
  'Aggregate(Func<T, T, T> func): T', 'Contains(T value): bool', 'ToList(): List<T>', 'ToArray(): T[]',
  'ToDictionary(Func<T, TKey> keySelector): Dictionary<TKey, T>', 'ToHashSet(): HashSet<T>', 'Chunk(int size): IEnumerable<T[]>',
];

const OBJECT = ['ToString(): string', 'Equals(object? obj): bool', 'GetHashCode(): int', 'GetType(): Type'];

const COLLECTION = ['Count: int', 'Add(T item): void', 'Remove(T item): bool', 'Clear(): void', 'Contains(T item): bool'];

export const BCL_TYPES = {
  Console: {
    namespace: 'System',
    static: [
      'WriteLine(string? value): void', 'Write(string? value): void', 'ReadLine(): string?', 'ReadKey(): ConsoleKeyInfo', 'Read(): int',
      'Clear(): void', 'Beep(): void', 'SetCursorPosition(int left, int top): void', 'ResetColor(): void',
      'ForegroundColor: ConsoleColor', 'BackgroundColor: ConsoleColor', 'Title: string', 'Out: TextWriter', 'Error: TextWriter',
      'In: TextReader', 'WindowWidth: int', 'WindowHeight: int', 'CursorVisible: bool', 'KeyAvailable: bool',
    ],
  },
  Math: {
    namespace: 'System',
    static: [
      'Abs(double value): double', 'Max(double a, double b): double', 'Min(double a, double b): double', 'Pow(double x, double y): double',
      'Sqrt(double d): double', 'Round(double a): double', 'Floor(double d): double', 'Ceiling(double a): double', 'Clamp(double value, double min, double max): double',
      'Sin(double a): double', 'Cos(double d): double', 'Tan(double a): double', 'Atan2(double y, double x): double', 'Log(double d): double',
      'Log10(double d): double', 'Exp(double d): double', 'Sign(double value): int', 'Truncate(double d): double', 'PI: double', 'E: double', 'Tau: double',
    ],
  },
  String: {
    namespace: 'System',
    alias: 'string',
    static: [
      'Empty: string', 'IsNullOrEmpty(string? value): bool', 'IsNullOrWhiteSpace(string? value): bool', 'Join(string separator, IEnumerable<string> values): string',
      'Concat(params string[] values): string', 'Format(string format, params object[] args): string', 'Compare(string a, string b): int', 'Equals(string a, string b): bool',
    ],
    instance: [
      'Length: int', 'Contains(string value): bool', 'StartsWith(string value): bool', 'EndsWith(string value): bool', 'IndexOf(string value): int',
      'LastIndexOf(string value): int', 'Substring(int startIndex, int length): string', 'Replace(string oldValue, string newValue): string',
      'Split(char separator): string[]', 'Trim(): string', 'TrimStart(): string', 'TrimEnd(): string', 'ToUpper(): string', 'ToLower(): string',
      'ToUpperInvariant(): string', 'ToLowerInvariant(): string', 'PadLeft(int totalWidth): string', 'PadRight(int totalWidth): string',
      'Insert(int startIndex, string value): string', 'Remove(int startIndex): string', 'ToCharArray(): char[]', 'Equals(string? value): bool',
      'CompareTo(string? value): int', 'AsSpan(): ReadOnlySpan<char>',
    ],
  },
  StringBuilder: {
    namespace: 'System.Text',
    instance: [
      'Append(string? value): StringBuilder', 'AppendLine(string? value): StringBuilder', 'AppendFormat(string format, params object[] args): StringBuilder',
      'Insert(int index, string? value): StringBuilder', 'Remove(int startIndex, int length): StringBuilder', 'Replace(string oldValue, string? newValue): StringBuilder',
      'Clear(): StringBuilder', 'Length: int', 'Capacity: int',
    ],
  },
  List: {
    namespace: 'System.Collections.Generic',
    enumerable: true,
    instance: [
      ...COLLECTION, 'AddRange(IEnumerable<T> collection): void', 'Insert(int index, T item): void', 'RemoveAt(int index): void',
      'RemoveAll(Predicate<T> match): int', 'IndexOf(T item): int', 'Find(Predicate<T> match): T?', 'FindAll(Predicate<T> match): List<T>',
      'FindIndex(Predicate<T> match): int', 'Exists(Predicate<T> match): bool', 'Sort(): void', 'ForEach(Action<T> action): void', 'Capacity: int',
    ],
  },
  Dictionary: {
    namespace: 'System.Collections.Generic',
    enumerable: true,
    instance: [
      'Count: int', 'Keys: IEnumerable<TKey>', 'Values: IEnumerable<TValue>', 'Add(TKey key, TValue value): void', 'TryAdd(TKey key, TValue value): bool',
      'Remove(TKey key): bool', 'ContainsKey(TKey key): bool', 'ContainsValue(TValue value): bool', 'TryGetValue(TKey key, out TValue value): bool',
      'GetValueOrDefault(TKey key): TValue?', 'Clear(): void',
    ],
  },
  HashSet: {
    namespace: 'System.Collections.Generic',
    enumerable: true,
    instance: [...COLLECTION, 'UnionWith(IEnumerable<T> other): void', 'IntersectWith(IEnumerable<T> other): void', 'ExceptWith(IEnumerable<T> other): void', 'IsSubsetOf(IEnumerable<T> other): bool', 'Overlaps(IEnumerable<T> other): bool'],
  },
  Queue: {
    namespace: 'System.Collections.Generic',
    enumerable: true,
    instance: ['Count: int', 'Enqueue(T item): void', 'Dequeue(): T', 'Peek(): T', 'TryDequeue(out T result): bool', 'TryPeek(out T result): bool', 'Clear(): void', 'Contains(T item): bool'],
  },
  Stack: {
    namespace: 'System.Collections.Generic',
    enumerable: true,
    instance: ['Count: int', 'Push(T item): void', 'Pop(): T', 'Peek(): T', 'TryPop(out T result): bool', 'TryPeek(out T result): bool', 'Clear(): void', 'Contains(T item): bool'],
  },
  IEnumerable: { namespace: 'System.Collections.Generic', enumerable: true, instance: ['GetEnumerator(): IEnumerator<T>'] },
  Array: {
    namespace: 'System',
    enumerable: true,
    static: ['Empty<T>(): T[]', 'Sort(Array array): void', 'Reverse(Array array): void', 'IndexOf(Array array, object? value): int', 'Resize(ref T[] array, int newSize): void', 'Fill(T[] array, T value): void', 'Copy(Array source, Array destination, int length): void'],
    instance: ['Length: int', 'Rank: int', 'CopyTo(Array array, int index): void', 'Clone(): object'],
  },
  Task: {
    namespace: 'System.Threading.Tasks',
    static: ['Run(Func<Task> function): Task', 'Delay(int millisecondsDelay): Task', 'WhenAll(params Task[] tasks): Task', 'WhenAny(params Task[] tasks): Task<Task>', 'FromResult(TResult result): Task<TResult>', 'CompletedTask: Task', 'Yield(): YieldAwaitable'],
    instance: ['Wait(): void', 'ContinueWith(Action<Task> continuationAction): Task', 'ConfigureAwait(bool continueOnCapturedContext): ConfiguredTaskAwaitable', 'IsCompleted: bool', 'IsFaulted: bool', 'IsCanceled: bool', 'Exception: AggregateException?', 'Result: TResult', 'GetAwaiter(): TaskAwaiter'],
  },
  File: {
    namespace: 'System.IO',
    static: [
      'ReadAllText(string path): string', 'ReadAllTextAsync(string path): Task<string>', 'ReadAllLines(string path): string[]', 'ReadAllBytes(string path): byte[]',
      'WriteAllText(string path, string? contents): void', 'WriteAllTextAsync(string path, string? contents): Task', 'WriteAllLines(string path, IEnumerable<string> contents): void',
      'WriteAllBytes(string path, byte[] bytes): void', 'AppendAllText(string path, string? contents): void', 'Exists(string? path): bool', 'Delete(string path): void',
      'Copy(string sourceFileName, string destFileName): void', 'Move(string sourceFileName, string destFileName): void', 'OpenRead(string path): FileStream',
      'OpenWrite(string path): FileStream', 'Create(string path): FileStream', 'ReadLines(string path): IEnumerable<string>',
    ],
  },
  Directory: {
    namespace: 'System.IO',
    static: ['Exists(string? path): bool', 'CreateDirectory(string path): DirectoryInfo', 'Delete(string path): void', 'GetFiles(string path): string[]', 'GetDirectories(string path): string[]', 'EnumerateFiles(string path): IEnumerable<string>', 'GetCurrentDirectory(): string', 'Move(string sourceDirName, string destDirName): void'],
  },
  Path: {
    namespace: 'System.IO',
    static: ['Combine(params string[] paths): string', 'Join(string? path1, string? path2): string', 'GetFileName(string? path): string?', 'GetFileNameWithoutExtension(string? path): string?', 'GetExtension(string? path): string?', 'GetDirectoryName(string? path): string?', 'GetFullPath(string path): string', 'GetTempPath(): string', 'GetTempFileName(): string', 'ChangeExtension(string? path, string? extension): string?', 'DirectorySeparatorChar: char'],
  },
  DateTime: {
    namespace: 'System',
    static: ['Now: DateTime', 'UtcNow: DateTime', 'Today: DateTime', 'MinValue: DateTime', 'MaxValue: DateTime', 'Parse(string s): DateTime', 'TryParse(string? s, out DateTime result): bool', 'DaysInMonth(int year, int month): int', 'IsLeapYear(int year): bool'],
    instance: ['Year: int', 'Month: int', 'Day: int', 'Hour: int', 'Minute: int', 'Second: int', 'Millisecond: int', 'DayOfWeek: DayOfWeek', 'DayOfYear: int', 'Date: DateTime', 'TimeOfDay: TimeSpan', 'Ticks: long', 'AddDays(double value): DateTime', 'AddHours(double value): DateTime', 'AddMinutes(double value): DateTime', 'AddSeconds(double value): DateTime', 'AddMonths(int months): DateTime', 'AddYears(int value): DateTime', 'ToString(string? format): string', 'ToUniversalTime(): DateTime', 'ToLocalTime(): DateTime', 'Subtract(DateTime value): TimeSpan'],
  },
  TimeSpan: {
    namespace: 'System',
    static: ['Zero: TimeSpan', 'FromSeconds(double value): TimeSpan', 'FromMinutes(double value): TimeSpan', 'FromHours(double value): TimeSpan', 'FromDays(double value): TimeSpan', 'FromMilliseconds(double value): TimeSpan', 'Parse(string s): TimeSpan'],
    instance: ['Days: int', 'Hours: int', 'Minutes: int', 'Seconds: int', 'Milliseconds: int', 'TotalDays: double', 'TotalHours: double', 'TotalMinutes: double', 'TotalSeconds: double', 'TotalMilliseconds: double', 'Ticks: long', 'Add(TimeSpan ts): TimeSpan', 'Subtract(TimeSpan ts): TimeSpan'],
  },
  Guid: {
    namespace: 'System',
    static: ['NewGuid(): Guid', 'Empty: Guid', 'Parse(string input): Guid', 'TryParse(string? input, out Guid result): bool', 'CreateVersion7(): Guid'],
    instance: ['ToString(string? format): string', 'ToByteArray(): byte[]'],
  },
  Environment: {
    namespace: 'System',
    static: ['NewLine: string', 'CurrentDirectory: string', 'MachineName: string', 'UserName: string', 'ProcessorCount: int', 'OSVersion: OperatingSystem', 'Version: Version', 'TickCount64: long', 'GetEnvironmentVariable(string variable): string?', 'SetEnvironmentVariable(string variable, string? value): void', 'GetCommandLineArgs(): string[]', 'GetFolderPath(SpecialFolder folder): string', 'Exit(int exitCode): void'],
  },
  Convert: {
    namespace: 'System',
    static: ['ToInt32(object? value): int', 'ToInt64(object? value): long', 'ToDouble(object? value): double', 'ToDecimal(object? value): decimal', 'ToBoolean(object? value): bool', 'ToString(object? value): string?', 'ToChar(object? value): char', 'ToByte(object? value): byte', 'ToDateTime(object? value): DateTime', 'ToBase64String(byte[] inArray): string', 'FromBase64String(string s): byte[]', 'ToHexString(byte[] inArray): string', 'FromHexString(string s): byte[]'],
  },
  Int32: { namespace: 'System', alias: 'int', static: ['Parse(string s): int', 'TryParse(string? s, out int result): bool', 'MaxValue: int', 'MinValue: int'], instance: ['CompareTo(int value): int', 'ToString(string? format): string'] },
  Int64: { namespace: 'System', alias: 'long', static: ['Parse(string s): long', 'TryParse(string? s, out long result): bool', 'MaxValue: long', 'MinValue: long'], instance: ['CompareTo(long value): int', 'ToString(string? format): string'] },
  Double: { namespace: 'System', alias: 'double', static: ['Parse(string s): double', 'TryParse(string? s, out double result): bool', 'IsNaN(double d): bool', 'IsInfinity(double d): bool', 'MaxValue: double', 'MinValue: double', 'Epsilon: double', 'NaN: double', 'PositiveInfinity: double', 'NegativeInfinity: double'], instance: ['CompareTo(double value): int', 'ToString(string? format): string'] },
  Decimal: { namespace: 'System', alias: 'decimal', static: ['Parse(string s): decimal', 'TryParse(string? s, out decimal result): bool', 'Round(decimal d, int decimals): decimal', 'MaxValue: decimal', 'MinValue: decimal', 'Zero: decimal', 'One: decimal'], instance: ['CompareTo(decimal value): int', 'ToString(string? format): string'] },
  Boolean: { namespace: 'System', alias: 'bool', static: ['Parse(string value): bool', 'TryParse(string? value, out bool result): bool', 'TrueString: string', 'FalseString: string'] },
  Char: { namespace: 'System', alias: 'char', static: ['IsDigit(char c): bool', 'IsLetter(char c): bool', 'IsLetterOrDigit(char c): bool', 'IsWhiteSpace(char c): bool', 'IsUpper(char c): bool', 'IsLower(char c): bool', 'ToUpper(char c): char', 'ToLower(char c): char', 'IsPunctuation(char c): bool'] },
  Random: { namespace: 'System', static: ['Shared: Random'], instance: ['Next(int minValue, int maxValue): int', 'NextDouble(): double', 'NextBytes(byte[] buffer): void', 'NextInt64(long minValue, long maxValue): long', 'Shuffle(T[] values): void'] },
  Exception: { namespace: 'System', instance: ['Message: string', 'InnerException: Exception?', 'StackTrace: string?', 'Source: string?', 'Data: IDictionary', 'HResult: int'] },
  Enumerable: { namespace: 'System.Linq', static: ['Range(int start, int count): IEnumerable<int>', 'Repeat(TResult element, int count): IEnumerable<TResult>', 'Empty<TResult>(): IEnumerable<TResult>'] },
  JsonSerializer: { namespace: 'System.Text.Json', static: ['Serialize(TValue value): string', 'Deserialize<TValue>(string json): TValue?', 'SerializeAsync(Stream utf8Json, TValue value): Task', 'DeserializeAsync<TValue>(Stream utf8Json): ValueTask<TValue?>'] },
  HttpClient: { namespace: 'System.Net.Http', instance: ['GetAsync(string? requestUri): Task<HttpResponseMessage>', 'GetStringAsync(string? requestUri): Task<string>', 'PostAsync(string? requestUri, HttpContent? content): Task<HttpResponseMessage>', 'PutAsync(string? requestUri, HttpContent? content): Task<HttpResponseMessage>', 'DeleteAsync(string? requestUri): Task<HttpResponseMessage>', 'SendAsync(HttpRequestMessage request): Task<HttpResponseMessage>', 'BaseAddress: Uri?', 'Timeout: TimeSpan', 'DefaultRequestHeaders: HttpRequestHeaders'] },
  Stopwatch: { namespace: 'System.Diagnostics', static: ['StartNew(): Stopwatch', 'GetTimestamp(): long', 'Frequency: long'], instance: ['Start(): void', 'Stop(): void', 'Reset(): void', 'Restart(): void', 'Elapsed: TimeSpan', 'ElapsedMilliseconds: long', 'ElapsedTicks: long', 'IsRunning: bool'] },
  Thread: { namespace: 'System.Threading', static: ['Sleep(int millisecondsTimeout): void', 'CurrentThread: Thread'], instance: ['Start(): void', 'Join(): void', 'Name: string?', 'IsAlive: bool', 'IsBackground: bool', 'ManagedThreadId: int'] },
  CancellationToken: { namespace: 'System.Threading', static: ['None: CancellationToken'], instance: ['IsCancellationRequested: bool', 'CanBeCanceled: bool', 'ThrowIfCancellationRequested(): void', 'Register(Action callback): CancellationTokenRegistration'] },
  CancellationTokenSource: { namespace: 'System.Threading', instance: ['Token: CancellationToken', 'Cancel(): void', 'CancelAfter(int millisecondsDelay): void', 'IsCancellationRequested: bool', 'Dispose(): void'] },
  Regex: { namespace: 'System.Text.RegularExpressions', static: ['IsMatch(string input, string pattern): bool', 'Match(string input, string pattern): Match', 'Matches(string input, string pattern): MatchCollection', 'Replace(string input, string pattern, string replacement): string', 'Split(string input, string pattern): string[]', 'Escape(string str): string'], instance: ['IsMatch(string input): bool', 'Match(string input): Match', 'Matches(string input): MatchCollection', 'Replace(string input, string replacement): string', 'Split(string input): string[]'] },
};

/** Common attributes, written without the "Attribute" suffix. */
export const ATTRIBUTES = [
  'Obsolete', 'Serializable', 'Flags', 'NonSerialized', 'Conditional', 'DebuggerDisplay', 'DebuggerStepThrough',
  'MethodImpl', 'DllImport', 'LibraryImport', 'StructLayout', 'ThreadStatic', 'CallerMemberName', 'CallerFilePath',
  'CallerLineNumber', 'NotNull', 'MaybeNull', 'NotNullWhen', 'MemberNotNull', 'AllowNull', 'DisallowNull',
  'JsonPropertyName', 'JsonIgnore', 'JsonConstructor', 'Required', 'Range', 'StringLength', 'Key', 'Fact', 'Theory',
  'InlineData', 'Test', 'TestCase', 'SetUp', 'TestMethod', 'TestClass', 'HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete',
  'Route', 'ApiController', 'FromBody', 'FromQuery', 'FromRoute', 'Authorize', 'AllowAnonymous', 'SuppressMessage',
  'AttributeUsage', 'InternalsVisibleTo', 'Experimental', 'SetsRequiredMembers', 'ModuleInitializer', 'SkipLocalsInit',
];

export const NAMESPACES = [
  'System', 'System.Buffers', 'System.Collections', 'System.Collections.Concurrent', 'System.Collections.Generic',
  'System.Collections.Immutable', 'System.Collections.ObjectModel', 'System.ComponentModel', 'System.ComponentModel.DataAnnotations',
  'System.Data', 'System.Diagnostics', 'System.Diagnostics.CodeAnalysis', 'System.Globalization', 'System.IO', 'System.IO.Compression',
  'System.Linq', 'System.Linq.Expressions', 'System.Net', 'System.Net.Http', 'System.Net.Http.Json', 'System.Net.Sockets',
  'System.Numerics', 'System.Reflection', 'System.Runtime.CompilerServices', 'System.Runtime.InteropServices', 'System.Security.Cryptography',
  'System.Text', 'System.Text.Encodings.Web', 'System.Text.Json', 'System.Text.Json.Serialization', 'System.Text.RegularExpressions',
  'System.Threading', 'System.Threading.Channels', 'System.Threading.Tasks', 'System.Timers', 'System.Xml', 'System.Xml.Linq',
  'Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Mvc', 'Microsoft.Extensions.Configuration',
  'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging', 'Microsoft.Extensions.Options',
  'Microsoft.EntityFrameworkCore', 'Xunit', 'NUnit.Framework',
];

/** Other frequently used type names, offered as plain type completions. */
export const COMMON_TYPES = [
  'Action', 'Func', 'Predicate', 'EventHandler', 'EventArgs', 'IDisposable', 'IAsyncDisposable', 'IEquatable', 'IComparable',
  'ICollection', 'IList', 'IDictionary', 'IReadOnlyList', 'IReadOnlyCollection', 'IReadOnlyDictionary', 'ISet', 'IAsyncEnumerable',
  'ValueTask', 'Span', 'ReadOnlySpan', 'Memory', 'ReadOnlyMemory', 'Nullable', 'Lazy', 'Tuple', 'ValueTuple', 'Uri', 'Version',
  'Type', 'Attribute', 'Enum', 'Object', 'Stream', 'FileStream', 'MemoryStream', 'StreamReader', 'StreamWriter', 'TextReader',
  'TextWriter', 'FileInfo', 'DirectoryInfo', 'Encoding', 'CultureInfo', 'ArgumentException', 'ArgumentNullException',
  'ArgumentOutOfRangeException', 'InvalidOperationException', 'NotImplementedException', 'NotSupportedException',
  'NullReferenceException', 'IndexOutOfRangeException', 'KeyNotFoundException', 'FormatException', 'IOException',
  'FileNotFoundException', 'TimeoutException', 'OperationCanceledException', 'TaskCanceledException', 'AggregateException',
  'ConcurrentDictionary', 'ConcurrentQueue', 'ImmutableArray', 'ImmutableList', 'ObservableCollection', 'LinkedList',
  'SortedDictionary', 'SortedList', 'SortedSet', 'PriorityQueue', 'KeyValuePair', 'BigInteger', 'Vector2', 'Vector3',
  'DateTimeOffset', 'DateOnly', 'TimeOnly', 'TimeZoneInfo', 'Interlocked', 'SemaphoreSlim', 'Monitor', 'Mutex', 'Timer',
  'Process', 'Debug', 'Trace', 'Activator', 'GC', 'BitConverter', 'Buffer', 'Index', 'Range', 'ILogger', 'IServiceCollection',
  'IServiceProvider', 'IConfiguration', 'IHost', 'WebApplication',
];

const MEMBER = /^(\w+)(<[^>]*>)?(\([^)]*\))?(?::\s*(.+))?$/;

export function parseMember(entry) {
  const [, name, , params, type] = MEMBER.exec(entry) ?? [];
  return { name, kind: params ? 'method' : 'property', params, type: type ?? '' };
}

const ALIASES = Object.fromEntries(Object.entries(BCL_TYPES).filter(([, t]) => t.alias).map(([name, t]) => [t.alias, name]));

/** Looks up a BCL type by name or C# keyword alias ("string" → String). Arrays map to Array. */
export function bclType(name) {
  if (!name) return null;
  const key = BCL_TYPES[name] ? name : ALIASES[name];
  return key ? { name: key, ...BCL_TYPES[key] } : null;
}

export { ENUMERABLE, OBJECT };
