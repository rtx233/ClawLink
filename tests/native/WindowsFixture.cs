using System;
using System.Drawing;
using System.Windows.Forms;
public static class WindowsFixture {
    [STAThread] public static void Main() {
        Application.EnableVisualStyles();
        var form = new Form { Text = "ClawLink UIA Fixture", Size = new Size(700, 500) };
        var marker = new Label { Text = "第一测试会话", AccessibleName = "第一测试会话", AutoSize = true, Location = new Point(20, 20) };
        var first = new Button { Text = "打开第一会话", AccessibleName = "打开第一会话", Location = new Point(20, 60), Width = 150 };
        var second = new Button { Text = "打开第二会话", AccessibleName = "打开第二会话", Location = new Point(190, 60), Width = 150 };
        var reply = new Panel { AccessibleName = "测试回复容器", Location = new Point(20, 110), Size = new Size(620, 220) };
        var replyText = new Label { Text = "历史回复", AccessibleName = "历史回复", AutoSize = true, Location = new Point(0, 0) }; reply.Controls.Add(replyText);
        var input = new TextBox { AccessibleName = "测试消息输入框", Location = new Point(20, 350), Width = 480 };
        var send = new Button { Text = "发送测试", AccessibleName = "发送测试", Location = new Point(520, 350), Width = 120 };
        first.Click += (s, e) => { marker.Text = marker.AccessibleName = "第一测试会话"; };
        second.Click += (s, e) => { marker.Text = marker.AccessibleName = "第二测试会话"; };
        send.Click += (s, e) => { string message = input.Text; replyText.Text += "\n" + message + "\n测试回复：" + message; replyText.AccessibleName = replyText.Text; input.Text = message == "保留草稿" ? "用户草稿" : ""; };
        form.Controls.AddRange(new Control[] { marker, first, second, reply, input, send });
        Application.Run(form);
    }
}
