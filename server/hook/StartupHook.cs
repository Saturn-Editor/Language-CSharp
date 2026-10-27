// Loaded through DOTNET_STARTUP_HOOKS when Saturn runs a debugged program in its terminal: holds the program
// before Main until netcoredbg has attached, so breakpoints on the first lines are hit.
using System;
using System.Diagnostics;
using System.Threading;

internal class StartupHook
{
    public static void Initialize()
    {
        var timeout = int.TryParse(Environment.GetEnvironmentVariable("SATURN_DEBUG_WAIT_MS"), out var ms) ? ms : 10000;
        var watch = Stopwatch.StartNew();
        while (!Debugger.IsAttached && watch.ElapsedMilliseconds < timeout)
        {
            Thread.Sleep(20);
        }
        // Give the debugger a moment to bind breakpoints in modules that are already loaded.
        if (Debugger.IsAttached) Thread.Sleep(200);
    }
}
