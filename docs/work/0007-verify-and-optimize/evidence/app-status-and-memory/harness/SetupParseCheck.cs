using System;
using System.IO;

namespace DSHProxy
{
    // Reads what the real command line printed (one file per answer, named
    // on the command line as kind=path) with the app's own parser, and says
    // what the app makes of it. Used to prove the two sides agree.
    internal static class SetupParseCheck
    {
        [STAThread]
        private static int Main(string[] args)
        {
            foreach (var arg in args)
            {
                var at = arg.IndexOf('=');
                var kind = arg.Substring(0, at);
                var parts = arg.Substring(at + 1).Split('|');
                var result = new Cli.Result { Code = int.Parse(parts[1]), Out = File.ReadAllText(parts[0]), Err = "" };
                if (kind == "status")
                {
                    var state = HarnessSetup.Read(result);
                    Console.WriteLine("status  -> state " + state.State + ", plan " + state.Planned + ", running " + state.HarnessRunning + ", row \"" + state.RowText() + "\"" + (state.Reason.Length > 0 ? ", reason \"" + state.Reason + "\"" : ""));
                }
                else
                {
                    var answer = HarnessSetup.ReadInstall(result);
                    Console.WriteLine("install -> ok " + answer.Ok + ", message \"" + answer.Message + "\"");
                }
            }
            return 0;
        }
    }
}