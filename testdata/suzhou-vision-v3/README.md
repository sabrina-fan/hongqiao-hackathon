# 视觉抽取评测数据 V3（苏州）

- 数量：20 项（11 张 Wikimedia Commons 授权照片 + 9 张合成卡片）
- 用途：`import-batches` 视觉抽取质量回归与线上有界验收；预期写在 `manifest.json`。
- 照片：`Wikimedia Commons`，CC BY 3.0 / CC BY-SA 4.0，逐张在 manifest 中记录 `title`、`license`、`artist`、`credit`、`page`；仅缩放到长边 1920 并保留原图内容。
- 合成卡片：PIL 生成（1080×1440），覆盖门票、纯地址、英文名、地图截图、双地点、馆区歧义、噪声、低对比、倾斜。
- 覆盖类别：真实地标照片（10 处苏州地标 + 1 处杭州西湖）、文本与票据、无文本地图、多地点、同名馆区、降质变体。

## 使用方式

```sh
# 单批上限 15 张，脚本会分两批上传并在结束后擦除访客
node /tmp/nextstop-v3-batch.mjs
```

判定标准见 `manifest.json` 的 `note` 字段。运行记录写入 `results.json`，访客数据在结束前擦除。

## 数据来源

| 文件 | 许可 | 来源页面 |
| --- | --- | --- |
| photo-humble-garden.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:%E6%8B%99%E6%94%BF%E5%9B%AD%E8%A7%81%E5%B1%B1%E6%A5%BC2024.11_(2).jpg |
| photo-tiger-hill.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Yunyan_Pagoda_20160514_(1).jpg |
| photo-lion-grove.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Lion_Grove_Garden_Suzhou_November_2017_007.jpg |
| photo-lingering-garden.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Lingering_Garden2.jpg |
| photo-hanshan-temple.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:%E5%AF%92%E5%B1%B1%E5%AF%BA%E9%90%98%E6%A8%93.jpg |
| photo-pingjiang-road.jpg | CC BY 3.0 | https://commons.wikimedia.org/wiki/File:A_gallery_bridge_in_Pingjiang_Road,_Gusu,_Suzhou,_Jiangsu,_China,_215000.jpg |
| photo-shantang-street.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:%E5%A4%9C%C2%B7%E5%B1%B1%E5%A1%98%E8%A1%97_01.jpg |
| photo-museum.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:%E8%8B%8F%E5%B7%9E%E5%8D%9A%E7%89%A9%E9%A6%86%C2%B7%E8%8B%8F%E5%B7%9E%C2%B7%E8%A5%BF%E5%8D%97%E5%90%91%E4%B8%9C%E5%8C%97.jpg |
| photo-master-nets.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Master_of_the_Nets_Garden_%E7%BD%91%E5%B8%88%E5%9B%AD_Main_Pond_photo_by_Christian_G%C3%A4nshirt.JPG |
| photo-jinji-lake.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Jinji_Lake_Suzhou_November_2017_001.jpg |
| photo-hangzhou-westlake.jpg | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:West_Lake_20240729.jpg |

## 2026-11-20 实测（production 4026a80，修复前基线）

| 指标 | 数值 |
| --- | --- |
| 正确 | 11 |
| 部分正确 | 2（英文名只命中园内子地点；双地点只返回虎丘） |
| 错误 | 1（杭州西湖的候选全部是苏州同名地点） |
| 失败 | 6（1800 像素照片主备两路均 15 秒超时） |

失败集中在高分辨率照片：归一化上限 1800 像素时，单张请求超出视觉上游 15 秒尝试上限。修复 `4ff306c` 把归一化上限降到 1280，部署后需重跑本数据复核。

## 2026-11-20 实测（production 4ff306c，1280 像素修复后）

| 指标 | 修复前（4026a80，1800 像素） | 修复后（4ff306c，1280 像素） |
| --- | ---: | ---: |
| 正确 | 11 | 14 |
| 部分正确 | 2 | 2 |
| 错误 | 1 | 1 |
| 失败 | 6 | 3 |

修复后恢复：寒山寺、拙政园、留园三张照片；仍失败的 3 张是夜景/低光照片（金鸡湖夜景、平江路廊桥、山塘街灯笼），主备两路共 4 次 15 秒超时、2 次 `non_stop`。低光照片是当前剩余的主要失败类别。
