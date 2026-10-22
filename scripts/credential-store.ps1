$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
$request = $raw | ConvertFrom-Json

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.ComponentModel;

namespace WinCodex {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public FileTime LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  public static class CredApi {
    [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential credential, uint flags);
    [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target, int type, int flags, out IntPtr credential);
    [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target, int type, int flags);
    [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr buffer);
    public static void Save(string target, string value) {
      byte[] blob = Encoding.Unicode.GetBytes(value);
      IntPtr memory = Marshal.AllocHGlobal(blob.Length);
      try {
        Marshal.Copy(blob, 0, memory, blob.Length);
        Credential item = new Credential { Type=1, TargetName=target, CredentialBlobSize=blob.Length, CredentialBlob=memory, Persist=2, UserName=Environment.UserName };
        if (!Write(ref item, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(memory); }
    }
    public static string Load(string target) {
      IntPtr pointer;
      if (!Read(target, 1, 0, out pointer)) {
        int error = Marshal.GetLastWin32Error();
        if (error == 1168) return null;
        throw new Win32Exception(error);
      }
      try {
        Credential item = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
        if (item.CredentialBlob == IntPtr.Zero || item.CredentialBlobSize <= 0) return null;
        byte[] blob = new byte[item.CredentialBlobSize];
        Marshal.Copy(item.CredentialBlob, blob, 0, blob.Length);
        return Encoding.Unicode.GetString(blob);
      } finally { CredFree(pointer); }
    }
    public static void Remove(string target) {
      if (!Delete(target, 1, 0)) {
        int error = Marshal.GetLastWin32Error();
        if (error != 1168) throw new Win32Exception(error);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source

switch ($request.operation) {
  'read' {
    $value = [WinCodex.CredApi]::Load([string]$request.target)
    [Console]::Out.Write((ConvertTo-Json -InputObject $value -Compress))
  }
  'write' {
    [WinCodex.CredApi]::Save([string]$request.target, [string]$request.value)
    [Console]::Out.Write('{}')
  }
  'delete' {
    [WinCodex.CredApi]::Remove([string]$request.target)
    [Console]::Out.Write('{}')
  }
  default { throw 'Unsupported Credential Manager operation' }
}
