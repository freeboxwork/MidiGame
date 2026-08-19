using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class MidiDevice
{
    private const string Alias = "codexSimpleMidiPlayer";
    private static bool isOpen;

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern int mciSendString(
        string command,
        StringBuilder returnValue,
        int returnLength,
        IntPtr callback);

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern bool mciGetErrorString(
        int errorCode,
        StringBuilder errorText,
        int errorTextSize);

    private static string Send(string command)
    {
        StringBuilder result = new StringBuilder(256);
        int error = mciSendString(command, result, result.Capacity, IntPtr.Zero);
        if (error != 0)
        {
            StringBuilder message = new StringBuilder(256);
            mciGetErrorString(error, message, message.Capacity);
            throw new InvalidOperationException(message.ToString());
        }
        return result.ToString().Trim();
    }

    public static void Open(string path)
    {
        Close();
        string safePath = path.Replace("\"", "\"\"");
        Send("open \"" + safePath + "\" type sequencer alias " + Alias);
        isOpen = true;
        Send("set " + Alias + " time format milliseconds");
    }

    public static void Play()
    {
        EnsureOpen();
        Send("seek " + Alias + " to start");
        Send("play " + Alias);
    }

    public static void Stop()
    {
        if (!isOpen)
            return;
        Send("stop " + Alias);
        Send("seek " + Alias + " to start");
    }

    public static long Position
    {
        get
        {
            EnsureOpen();
            return ParseLong(Send("status " + Alias + " position"));
        }
    }

    public static long Length
    {
        get
        {
            EnsureOpen();
            return ParseLong(Send("status " + Alias + " length"));
        }
    }

    public static string Mode
    {
        get
        {
            EnsureOpen();
            return Send("status " + Alias + " mode");
        }
    }

    public static void Close()
    {
        if (!isOpen)
            return;
        try
        {
            Send("close " + Alias);
        }
        finally
        {
            isOpen = false;
        }
    }

    private static void EnsureOpen()
    {
        if (!isOpen)
            throw new InvalidOperationException("먼저 MIDI 파일을 열어주세요.");
    }

    private static long ParseLong(string text)
    {
        long value;
        if (!long.TryParse(text, out value))
            throw new InvalidOperationException("재생 시간을 읽지 못했습니다.");
        return value;
    }
}

internal sealed class PlayerForm : Form
{
    private readonly Label fileLabel;
    private readonly Label statusLabel;
    private readonly Button openButton;
    private readonly Button playButton;
    private readonly Button stopButton;
    private readonly System.Windows.Forms.Timer timer;
    private string currentFile;
    private long duration;
    private bool hasPlayed;

    public PlayerForm(string initialFile)
    {
        Text = "Simple MIDI Player";
        ClientSize = new Size(430, 170);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(245, 246, 248);
        Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
        AllowDrop = true;

        Label title = new Label();
        title.Text = "MIDI Player";
        title.Font = new Font("Segoe UI Semibold", 15F, FontStyle.Bold, GraphicsUnit.Point);
        title.ForeColor = Color.FromArgb(30, 33, 38);
        title.AutoSize = true;
        title.Location = new Point(18, 14);
        Controls.Add(title);

        fileLabel = new Label();
        fileLabel.Text = "MIDI 파일을 열어주세요";
        fileLabel.ForeColor = Color.FromArgb(83, 88, 98);
        fileLabel.AutoEllipsis = true;
        fileLabel.Location = new Point(20, 52);
        fileLabel.Size = new Size(390, 22);
        Controls.Add(fileLabel);

        openButton = CreateButton("파일 열기", 20, 88, 105, Color.White, Color.FromArgb(42, 46, 54));
        playButton = CreateButton("▶  재생", 135, 88, 130, Color.FromArgb(37, 99, 235), Color.White);
        stopButton = CreateButton("■  정지", 275, 88, 130, Color.FromArgb(225, 228, 233), Color.FromArgb(42, 46, 54));
        playButton.Enabled = false;
        stopButton.Enabled = false;
        Controls.Add(openButton);
        Controls.Add(playButton);
        Controls.Add(stopButton);

        statusLabel = new Label();
        statusLabel.Text = "준비";
        statusLabel.ForeColor = Color.FromArgb(99, 105, 115);
        statusLabel.Location = new Point(20, 136);
        statusLabel.Size = new Size(385, 22);
        Controls.Add(statusLabel);

        openButton.Click += delegate { ChooseFile(); };
        playButton.Click += delegate { PlayCurrent(); };
        stopButton.Click += delegate { StopCurrent(); };
        DragEnter += OnDragEnter;
        DragDrop += OnDragDrop;
        FormClosed += delegate { MidiDevice.Close(); };

        timer = new System.Windows.Forms.Timer();
        timer.Interval = 250;
        timer.Tick += delegate { UpdateStatus(); };
        timer.Start();

        if (!string.IsNullOrEmpty(initialFile) && File.Exists(initialFile))
            LoadFile(initialFile);
    }

    private Button CreateButton(string text, int x, int y, int width, Color backColor, Color foreColor)
    {
        Button button = new Button();
        button.Text = text;
        button.Location = new Point(x, y);
        button.Size = new Size(width, 36);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = Color.FromArgb(210, 214, 221);
        button.BackColor = backColor;
        button.ForeColor = foreColor;
        button.Cursor = Cursors.Hand;
        return button;
    }

    private void ChooseFile()
    {
        using (OpenFileDialog dialog = new OpenFileDialog())
        {
            dialog.Title = "MIDI 파일 선택";
            dialog.Filter = "MIDI 파일 (*.mid;*.midi)|*.mid;*.midi|모든 파일 (*.*)|*.*";
            if (dialog.ShowDialog(this) == DialogResult.OK)
                LoadFile(dialog.FileName);
        }
    }

    private void LoadFile(string path)
    {
        try
        {
            MidiDevice.Open(path);
            currentFile = path;
            duration = MidiDevice.Length;
            hasPlayed = false;
            fileLabel.Text = Path.GetFileName(path);
            fileLabel.Tag = path;
            fileLabel.Cursor = Cursors.Hand;
            ToolTip tip = new ToolTip();
            tip.SetToolTip(fileLabel, path);
            statusLabel.Text = "준비 · " + FormatTime(duration);
            playButton.Enabled = true;
            stopButton.Enabled = false;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "MIDI 파일을 열 수 없습니다.\n\n" + ex.Message, "재생 오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void PlayCurrent()
    {
        if (string.IsNullOrEmpty(currentFile))
            return;
        try
        {
            MidiDevice.Play();
            hasPlayed = true;
            playButton.Text = "↻  다시 재생";
            stopButton.Enabled = true;
            statusLabel.Text = "재생 중 · 0:00 / " + FormatTime(duration);
        }
        catch (Exception ex)
        {
            ShowPlaybackError(ex);
        }
    }

    private void StopCurrent()
    {
        try
        {
            MidiDevice.Stop();
            stopButton.Enabled = false;
            statusLabel.Text = "정지 · 0:00 / " + FormatTime(duration);
        }
        catch (Exception ex)
        {
            ShowPlaybackError(ex);
        }
    }

    private void UpdateStatus()
    {
        if (string.IsNullOrEmpty(currentFile))
            return;
        try
        {
            string mode = MidiDevice.Mode.ToLowerInvariant();
            long position = MidiDevice.Position;
            if (mode == "playing")
            {
                statusLabel.Text = "재생 중 · " + FormatTime(position) + " / " + FormatTime(duration);
                stopButton.Enabled = true;
            }
            else if (hasPlayed && position >= duration - 100)
            {
                statusLabel.Text = "재생 완료 · " + FormatTime(duration);
                stopButton.Enabled = false;
            }
        }
        catch
        {
            // A transient status read should not interrupt playback.
        }
    }

    private void OnDragEnter(object sender, DragEventArgs e)
    {
        string[] files = e.Data.GetData(DataFormats.FileDrop) as string[];
        if (files != null && files.Length > 0 && IsMidi(files[0]))
            e.Effect = DragDropEffects.Copy;
    }

    private void OnDragDrop(object sender, DragEventArgs e)
    {
        string[] files = e.Data.GetData(DataFormats.FileDrop) as string[];
        if (files != null && files.Length > 0 && IsMidi(files[0]))
            LoadFile(files[0]);
    }

    private static bool IsMidi(string path)
    {
        string extension = Path.GetExtension(path).ToLowerInvariant();
        return extension == ".mid" || extension == ".midi";
    }

    private static string FormatTime(long milliseconds)
    {
        TimeSpan time = TimeSpan.FromMilliseconds(Math.Max(0, milliseconds));
        return ((int)time.TotalMinutes).ToString() + ":" + time.Seconds.ToString("00");
    }

    private void ShowPlaybackError(Exception ex)
    {
        MessageBox.Show(this, "재생할 수 없습니다.\n\n" + ex.Message, "재생 오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--self-test")
            return SelfTest(args[1]);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PlayerForm(FindInitialFile(args)));
        return 0;
    }

    private static string FindInitialFile(string[] args)
    {
        if (args.Length > 0 && File.Exists(args[0]))
            return Path.GetFullPath(args[0]);

        string folder = AppDomain.CurrentDomain.BaseDirectory;
        string bundled = Path.Combine(folder, "midnight_circuit_jazz.mid");
        if (File.Exists(bundled))
            return bundled;

        string[] files = Directory.GetFiles(folder, "*.mid");
        return files.Length > 0 ? files[0] : null;
    }

    private static int SelfTest(string path)
    {
        try
        {
            MidiDevice.Open(path);
            long length = MidiDevice.Length;
            if (length <= 0)
                return 2;
            MidiDevice.Play();
            Thread.Sleep(500);
            long position = MidiDevice.Position;
            bool playing = MidiDevice.Mode.ToLowerInvariant() == "playing";
            MidiDevice.Stop();
            MidiDevice.Close();
            return playing && position > 0 ? 0 : 3;
        }
        catch
        {
            MidiDevice.Close();
            return 1;
        }
    }
}
