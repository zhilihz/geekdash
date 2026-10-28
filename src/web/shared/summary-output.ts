import {esc} from './api';
import {pngColumns,summaryColumns,summaryValue,type SummaryProject,type SummaryColumn,type SummarySnapshot} from './summary';

export function printSummary(projects:SummaryProject[],columns:SummaryColumn[],title:string,snapshot:SummarySnapshot){
  if(!projects.length)throw new Error('请先选择要导出的项目。');
  const popup=window.open('','_blank');if(!popup)throw new Error('打印窗口被浏览器拦截，请允许本页打开打印窗口后重试。');
  popup.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A3 landscape;margin:12mm}body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;font-size:10px}h1{font-size:20px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #aaa;padding:7px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eef1f4}thead{display:table-header-group}button{padding:8px 16px;margin:12px 0}@media print{button{display:none}}</style></head><body><h1>${esc(title)}</h1><p>${esc(snapshot.businessDate)}　${projects.length} 个项目　${esc(snapshot.company?.fullName ?? '')}</p><p>数据读取时间：${esc(snapshot.capturedAt)}</p><button id="print">打印 / 保存为 PDF</button><table><thead><tr>${columns.map(c=>'<th>'+summaryColumns[c]+'</th>').join('')}</tr></thead><tbody>${projects.map(p=>'<tr>'+columns.map(c=>'<td>'+esc(summaryValue(p,c) || '—')+'</td>').join('')+'</tr>').join('')}</tbody></table></body></html>`);
  popup.document.close();popup.document.getElementById('print')!.onclick=()=>popup.print();popup.focus();popup.print();
}

export async function summaryPng(projects:SummaryProject[],visible:SummaryColumn[],title:string,snapshot:SummarySnapshot):Promise<Blob>{
  if(!projects.length)throw new Error('请先选择要导出的项目。');
  await document.fonts?.ready;
  const columns=pngColumns.filter(c=>visible.includes(c)),widths:Record<string,number>={name:240,customer:180,status:390,projectOwners:180,engineers:180,dueDate:160,delay:150};
  const width=columns.reduce((sum,c)=>sum+widths[c],0)+48,rowHeight=108,height=164+projects.length*rowHeight;
  // ponytail: 浏览器单张画布有尺寸上限；超出时明确改用完整CSV/PDF，不截掉项目。
  if(height>30000 || width*height>32000000)throw new Error('本次项目过多，无法生成一张完整摘要图，请减少选择或导出 CSV、PDF。');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');if(!context)throw new Error('浏览器无法生成图片，请重试或使用 CSV。');
  context.fillStyle='#ffffff';context.fillRect(0,0,width,height);context.fillStyle='#17202a';context.font='bold 24px "Microsoft YaHei",sans-serif';context.fillText(title,24,40,width-48);context.font='14px "Microsoft YaHei",sans-serif';context.fillStyle='#596574';context.fillText(`${snapshot.businessDate}　${projects.length} 个项目　摘要图（长文省略）`,24,70,width-48);
  const lines=(value:string,maxWidth:number,maxLines:number)=>{const result:string[]=[];let line='';for(const char of Array.from(value.replace(/\r\n?/g,'\n'))){if(char==='\n' || context.measureText(line+char).width>maxWidth){result.push(line);line=char==='\n'?'':char;}else line+=char;}result.push(line);if(result.length>maxLines){const last=result[maxLines-1];let clipped=last;while(context.measureText(clipped+'…').width>maxWidth)clipped=clipped.slice(0,-1);result[maxLines-1]=clipped+'…';}return result.slice(0,maxLines);};
  context.fillStyle='#edf1f5';context.fillRect(24,88,width-48,44);let x=24;context.font='bold 14px "Microsoft YaHei",sans-serif';context.fillStyle='#263443';for(const column of columns){context.fillText(summaryColumns[column],x+12,116);x+=widths[column];}
  context.font='14px "Microsoft YaHei",sans-serif';projects.forEach((project,index)=>{const y=132+index*rowHeight;if(index%2===1){context.fillStyle='#f6f8fa';context.fillRect(24,y,width-48,rowHeight);}x=24;context.fillStyle='#263443';for(const column of columns){lines(summaryValue(project,column) || '—',widths[column]-24,3).forEach((line,n)=>context.fillText(line,x+12,y+27+n*23));x+=widths[column];}context.strokeStyle='#dde3ea';context.beginPath();context.moveTo(24,y+rowHeight);context.lineTo(width-24,y+rowHeight);context.stroke();});
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图片生成失败，当前选择已保留。')),'image/png'));
}
