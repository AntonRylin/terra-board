import sharp from 'sharp';
import {mkdirSync} from 'node:fs';
mkdirSync('.local-test',{recursive:true});
const image=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><rect width="960" height="640" fill="#dce7ed"/><circle cx="600" cy="255" r="175" fill="#a8bcb0"/><rect x="135" y="190" width="310" height="340" rx="24" fill="#f4ece0"/><path d="M120 570L820 490" stroke="#6f8c83" stroke-width="12"/><text x="155" y="275" font-family="sans-serif" font-size="40" fill="#3c4e50">Local media</text><text x="155" y="325" font-family="sans-serif" font-size="22" fill="#74877f">Original + previews</text></svg>');
await sharp(image).png().toFile('.local-test/reference.png');
