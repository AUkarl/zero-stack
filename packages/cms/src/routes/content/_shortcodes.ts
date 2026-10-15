/**
 * _shortcodes.ts — 正文可插入的 Hugo 短代码。
 *
 * 名称与参数全部照 zero-theme/layouts/shortcodes/ 下的实际模板抄写，不发明新短代码：
 *   figure / video / audio / bilibili / youtube / music163 / audio-163 / audio-qq / audio-kugou
 *   video-bilibili / video-youtube / video-tencent / video-youku / code / notice / blockquote / gallery / katex
 * 成对短代码（code / notice / blockquote / gallery / katex）用 {{< name >}}…{{< /name >}}，正文写在中间。
 */

export interface Shortcode {
  label: string;
  /** 分组名，下拉里按组分 optgroup */
  group: string;
  text: string;
  /** 插入后要选中的片段，方便直接改占位内容 */
  pick: string;
}

export const SHORTCODES: Shortcode[] = [
  {
    label: '图片 figure',
    group: '媒体',
    text: '{{< figure src="https://example.com/img.jpg" alt="图片描述" caption="图片说明" >}}\n',
    pick: 'https://example.com/img.jpg',
  },
  {
    label: '多图画廊 gallery',
    group: '媒体',
    text:
      '{{< gallery columns="3" >}}\n![图一](https://example.com/a.jpg)\n![图二](https://example.com/b.jpg)\n{{< /gallery >}}\n',
    pick: 'https://example.com/a.jpg',
  },
  {
    label: '视频 video',
    group: '媒体',
    text: '{{< video src="https://example.com/clip.mp4" poster="https://example.com/cover.jpg" caption="视频说明" >}}\n',
    pick: 'https://example.com/clip.mp4',
  },
  {
    label: '音频 audio',
    group: '媒体',
    text: '{{< audio src="https://example.com/song.mp3" title="歌曲名" artist="艺术家" >}}\n',
    pick: 'https://example.com/song.mp3',
  },
  {
    label: 'B 站 bilibili',
    group: '媒体',
    text: '{{< bilibili id="BV1xx411c7mD" page="1" >}}\n',
    pick: 'BV1xx411c7mD',
  },
  {
    label: 'B 站（video-bilibili）',
    group: '媒体',
    text: '{{< video-bilibili bvid="BV1xx411c7mD" page="1" >}}\n',
    pick: 'BV1xx411c7mD',
  },
  {
    label: 'YouTube',
    group: '媒体',
    text: '{{< youtube id="dQw4w9WgXcQ" start="30" >}}\n',
    pick: 'dQw4w9WgXcQ',
  },
  {
    label: 'YouTube（video-youtube）',
    group: '媒体',
    text: '{{< video-youtube id="dQw4w9WgXcQ" >}}\n',
    pick: 'dQw4w9WgXcQ',
  },
  {
    label: '网易云音乐 music163',
    group: '媒体',
    text: '{{< music163 id="1234567890" type="song" >}}\n',
    pick: '1234567890',
  },
  {
    label: '网易云单曲 audio-163',
    group: '媒体',
    text: '{{< audio-163 id="1234567890" >}}\n',
    pick: '1234567890',
  },
  {
    label: 'QQ 音乐 audio-qq',
    group: '媒体',
    text: '{{< audio-qq id="203866179" >}}\n',
    pick: '203866179',
  },
  {
    label: '酷狗音乐 audio-kugou',
    group: '媒体',
    text: '{{< audio-kugou id="歌曲hash" title="歌名" artist="歌手" >}}\n',
    pick: '歌曲hash',
  },
  {
    label: '腾讯视频 video-tencent',
    group: '媒体',
    text: '{{< video-tencent id="vid" >}}\n',
    pick: 'vid',
  },
  {
    label: '优酷视频 video-youku',
    group: '媒体',
    text: '{{< video-youku id="视频id" >}}\n',
    pick: '视频id',
  },
  {
    label: '代码高亮 code',
    group: '代码',
    text: '{{< code lang="typescript" title="示例代码" >}}\n把代码粘贴在这里\n{{< /code >}}\n',
    pick: '把代码粘贴在这里',
  },
  {
    label: '提示框 notice',
    group: '排版',
    text: '{{< notice type="info" title="提示" >}}\n这是一条提示信息\n{{< /notice >}}\n',
    pick: '这是一条提示信息',
  },
  {
    label: '增强引用 blockquote',
    group: '排版',
    text: '{{< blockquote author="作者名" cite="https://example.com" >}}\n引用内容\n{{< /blockquote >}}\n',
    pick: '引用内容',
  },
  {
    label: '数学公式 katex',
    group: '排版',
    text: '{{< katex >}}E = mc^2{{< /katex >}}\n',
    pick: 'E = mc^2',
  },
];

