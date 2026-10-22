param(
  [Parameter(Mandatory=$true)][ValidateSet('canonical-root','info','list','read')][string]$Operation,
  [string]$RootPath,
  [string]$TargetPath,
  [ValidateRange(0,2147483647)][int]$ListOffset = 0,
  [ValidateRange(1,500)][int]$ListLimit = 500,
  [long]$MaxBytes = 67108864,
  [long]$Offset = 0,
  [long]$Length = 67108864
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WinCodex {
  [StructLayout(LayoutKind.Sequential)]
  public struct ByHandleFileInformation {
    public uint Attributes;
    public uint CreationLow, CreationHigh;
    public uint AccessLow, AccessHigh;
    public uint WriteLow, WriteHigh;
    public uint VolumeSerial;
    public uint SizeHigh, SizeLow;
    public uint LinkCount;
    public uint FileIndexHigh, FileIndexLow;
  }
  public static class SafeFs {
    const uint OpenExisting = 3, ShareRead = 1, ShareWrite = 2, ShareDelete = 4;
    const uint BackupSemantics = 0x02000000, ReadAttributes = 0x80, GenericRead = 0x80000000;
    const uint ReparsePoint = 0x400;
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint="GetFinalPathNameByHandleW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);
    static string Normalize(string value) {
      if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) value = "\\\\" + value.Substring(8);
      else if (value.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
      string full = Path.GetFullPath(value);
      string volume = Path.GetPathRoot(full);
      return String.Equals(full, volume, StringComparison.OrdinalIgnoreCase) ? full : full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
    static bool Inside(string root, string target) {
      string r = Normalize(root), t = Normalize(target);
      string prefix = r.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ? r : r + Path.DirectorySeparatorChar;
      return String.Equals(r, t, StringComparison.OrdinalIgnoreCase) || t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }
    static SafeFileHandle Open(string path, bool readContent) {
      SafeFileHandle handle = CreateFile(path, readContent ? GenericRead : ReadAttributes, ShareRead | ShareWrite | ShareDelete, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero);
      if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
      return handle;
    }
    static string Final(SafeFileHandle handle) {
      StringBuilder result = new StringBuilder(32768);
      uint count = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
      if (count == 0 || count >= result.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
      return Normalize(result.ToString());
    }
    static ByHandleFileInformation Info(SafeFileHandle handle) {
      ByHandleFileInformation info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return info;
    }
    static long FileSize(ByHandleFileInformation info) { return ((long)info.SizeHigh << 32) | info.SizeLow; }
    static DateTime WriteTime(ByHandleFileInformation info) {
      long ticks = ((long)info.WriteHigh << 32) | info.WriteLow;
      return DateTime.FromFileTimeUtc(ticks);
    }
    static void RejectReparseComponents(string root, string target) {
      string r = Normalize(root), t = Normalize(target);
      if (!Inside(r, t)) throw new UnauthorizedAccessException("Target is outside the authorized root.");
      string relative = t.Length == r.Length ? "" : t.Substring(r.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
      string current = r;
      CheckNotReparse(current);
      foreach (string part in relative.Split(new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)) {
        current = Path.Combine(current, part);
        CheckNotReparse(current);
      }
    }
    static void CheckNotReparse(string path) {
      FileAttributes attributes = File.GetAttributes(path);
      if ((attributes & (FileAttributes)ReparsePoint) != 0) throw new UnauthorizedAccessException("Unsupported reparse point path.");
    }
    static SafeFileHandle OpenVerified(string root, string target, bool readContent, out ByHandleFileInformation info) {
      string normalizedRoot = Normalize(root), normalizedTarget = Normalize(target);
      RejectReparseComponents(normalizedRoot, normalizedTarget);
      using (SafeFileHandle rootHandle = Open(normalizedRoot, false)) {
        string actualRoot = Final(rootHandle);
        if (!String.Equals(actualRoot, normalizedRoot, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Authorized root target changed.");
        info = new ByHandleFileInformation();
      }
      SafeFileHandle targetHandle = Open(normalizedTarget, readContent);
      try {
        string actualTarget = Final(targetHandle);
        if (!Inside(normalizedRoot, actualTarget)) throw new UnauthorizedAccessException("Resolved target is outside the authorized root.");
        info = Info(targetHandle);
        if ((info.Attributes & ReparsePoint) != 0) throw new UnauthorizedAccessException("Unsupported reparse point path.");
        return targetHandle;
      } catch { targetHandle.Dispose(); throw; }
    }
    public static string CanonicalRoot(string path) {
      using (SafeFileHandle handle = Open(path, false)) {
        ByHandleFileInformation info = Info(handle);
        if ((info.Attributes & (uint)FileAttributes.Directory) == 0) throw new IOException("Selected path is not a directory.");
        if ((info.Attributes & ReparsePoint) != 0) throw new UnauthorizedAccessException("Authorized root cannot be a reparse point.");
        return Final(handle);
      }
    }
    public static object GetInfo(string root, string path) {
      ByHandleFileInformation info;
      using (SafeFileHandle handle = OpenVerified(root, path, false, out info)) {
        string actual = Final(handle);
        bool directory = (info.Attributes & (uint)FileAttributes.Directory) != 0;
        return new { finalPath = actual, isDirectory = directory, size = directory ? 0L : FileSize(info), modified = WriteTime(info).ToString("o") };
      }
    }
    public static object ReadRange(string root, string path, long maxBytes, long offset, long length) {
      ByHandleFileInformation info;
      using (SafeFileHandle handle = OpenVerified(root, path, true, out info)) {
        if ((info.Attributes & (uint)FileAttributes.Directory) != 0) throw new IOException("Target is a directory.");
        long size = FileSize(info);
        if (size > maxBytes) throw new IOException("File exceeds the configured read limit.");
        if (offset < 0 || length < 0 || offset > size) throw new IOException("Read offset is outside the file.");
        using (FileStream input = new FileStream(handle, FileAccess.Read, 8192, false)) {
          input.Seek(offset, SeekOrigin.Begin);
          byte[] buffer = new byte[8192];
          long remaining = Math.Min(length, size - offset);
          Stream output = Console.OpenStandardOutput();
          while (remaining > 0) {
            int wanted = (int)Math.Min(buffer.Length, remaining);
            int count = input.Read(buffer, 0, wanted);
            if (count <= 0) break;
            output.Write(buffer, 0, count);
            remaining -= count;
          }
          output.Flush();
        }
        return new { size = size };
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll', 'System.Core.dll')

try {
  if ($Operation -eq 'canonical-root') {
    $result = [WinCodex.SafeFs]::CanonicalRoot($TargetPath)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::Out.Write($result)
  } elseif ($Operation -eq 'info') {
    $result = [WinCodex.SafeFs]::GetInfo($RootPath, $TargetPath)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress))
  } elseif ($Operation -eq 'list') {
    [void][WinCodex.SafeFs]::GetInfo($RootPath, $TargetPath)
    $entries = New-Object System.Collections.Generic.List[object]
    $total = 0
    foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($TargetPath)) {
      $total++
      if ($total -le $ListOffset -or $total -gt ($ListOffset + $ListLimit)) { continue }
      try {
        $entry = [WinCodex.SafeFs]::GetInfo($RootPath, $child)
        $entries.Add(@{ name=[System.IO.Path]::GetFileName($child); path=$child; type=if ($entry.isDirectory) {'directory'} else {'file'}; size=$entry.size; modified=$entry.modified })
      } catch {
        $entries.Add(@{ name=[System.IO.Path]::GetFileName($child); path=$child; type='blocked_reparse'; size=0; modified=$null })
      }
    }
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::Out.Write((ConvertTo-Json -InputObject @{ entries=@($entries.ToArray()); total=$total } -Depth 5 -Compress))
  } elseif ($Operation -eq 'read') {
    [void][WinCodex.SafeFs]::ReadRange($RootPath, $TargetPath, $MaxBytes, $Offset, $Length)
  }
} catch {
  $code = 'file_access_failed'
  $exception = $_.Exception.GetBaseException()
  $errorMessage = $exception.Message
  if ($errorMessage -like '*Unsupported reparse point*' -or $errorMessage -like '*outside the authorized root*' -or $errorMessage -like '*Resolved target is outside*') { $code = 'unsupported_path' }
  elseif ($errorMessage -like '*Authorized root target changed*') { $code = 'permission_revoked' }
  elseif ($exception -is [System.UnauthorizedAccessException]) { $code = 'permission_denied' }
  elseif ($exception -is [System.IO.FileNotFoundException] -or $exception -is [System.IO.DirectoryNotFoundException]) { $code = 'file_not_found' }
  elseif ($exception -is [System.ComponentModel.Win32Exception]) {
    if ($exception.NativeErrorCode -in @(2,3)) { $code = 'file_not_found' }
    elseif ($exception.NativeErrorCode -eq 5) { $code = 'permission_denied' }
    elseif ($exception.NativeErrorCode -in @(53,67,1231)) { $code = 'unsupported_path' }
  }
  elseif ($exception -is [System.IO.IOException]) {
    if ($errorMessage -like '*exceeds the configured read limit*') { $code = 'file_too_large' }
    elseif ($errorMessage -like '*is a directory*') { $code = 'not_file' }
    elseif ($errorMessage -like '*outside the file*') { $code = 'invalid_path_or_argument' }
  }
  $message = ($errorMessage -replace '[\r\n]+',' ').Trim()
  [Console]::Error.WriteLine(('WC:{0}:{1}' -f $code,$message))
  exit 2
}
