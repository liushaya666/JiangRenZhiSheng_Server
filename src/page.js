export function photoPage(row) {
  const available = Boolean(row);
  const expiry = available ? new Date(row.expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${available ? '领取你的照片' : '照片暂不可领取'} · 匠人之声</title>
<link rel="stylesheet" href="/assets/claim.css"></head><body><main>
<header><span class="mark" aria-hidden="true">匠</span><div>匠人之声<small>留住这一刻的你</small></div></header>
<p class="eyebrow">一张照片，一段新体验</p>
<h1>${available ? '新造型，带回家。' : '这张照片暂不可领取'}</h1>
${available ? `<p class="intro">你的专属照片已准备好，请及时保存。</p>
<aside class="save-guide"><strong>长按下方照片，选择“保存图片”</strong><p>下方展示的就是完整照片，可直接长按保存到手机相册。</p></aside>
<figure><img src="/api/photos/${row.token}/image" width="${row.width}" height="${row.height}" alt="本次匠人之声体验生成的个人照片" fetchpriority="high"></figure>
<p class="expiry">领取有效期至 ${expiry}（北京时间）</p>` : `<p class="intro">领取链接可能有误或已过期。请返回体验设备确认，或联系现场工作人员。</p><div class="empty" aria-hidden="true">此刻的美好，期待再次相遇。</div>`}
<footer>照片链接可供持有者访问，请妥善保管。<br>到期后，服务器将自动清理照片。</footer>
</main></body></html>`;
}
