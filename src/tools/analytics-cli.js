import {
  getAnalyticsSummary,
  getAnalyticsDailyUsage,
  getAnalyticsByModel,
  getAnalyticsByProvider,
} from '../database.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const days = Math.max(1, parseInt(args.find(a => /^\d+$/.test(a)) || '14', 10));

const summary = getAnalyticsSummary(days);

console.log(`\n  Wanar AI Analytics - ${days} hari terakhir`);
console.log('  ' + '='.repeat(46));
console.log(`  Total request     : ${summary.totalRequests}`);
console.log(`  Total token       : ${summary.totalTokens.toLocaleString('id-ID')}`);
console.log(`  Rata-rata respons : ${summary.avgResponseTime} ms`);

if (!flags.has('--summary')) {
  const daily = getAnalyticsDailyUsage(days);
  if (daily.length > 0) {
    console.log('\n  Penggunaan harian:');
    console.table(daily.map(d => ({ tanggal: d.date, request: d.requests, token: d.tokens })));
  }

  const byModel = getAnalyticsByModel(days);
  if (byModel.length > 0) {
    console.log('\n  Per model:');
    console.table(byModel.map(m => ({
      model: m.model,
      request: m.requests,
      token: m.tokens,
    })));
  }

  const byProvider = getAnalyticsByProvider(days);
  if (byProvider.length > 0) {
    console.log('\n  Per provider:');
    console.table(byProvider.map(p => ({
      provider: p.provider,
      request: p.requests,
      token: p.tokens,
    })));
  }
}

console.log('');
