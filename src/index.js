// Wanar AI - Main Entry Point
// Professional AI Agent with Dual Provider Support

import readline from 'readline';

console.log('\n' + '='.repeat(55));
console.log('  WANAR AI v1.0 - Professional AI Agent');
console.log('  Dual Provider: Yunwu.ai + Puter.js');
console.log('='.repeat(55) + '\n');
console.log('Select interface:');
console.log('  1) Terminal CLI  - Chat directly in terminal');
console.log('  2) Web Server   - Open web interface in browser');
console.log('\n');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Enter choice (1 or 2): ', (answer) => {
    rl.close();
    
    switch (answer.trim()) {
        case '1':
        case 'cli':
            console.log('\nStarting CLI mode...\n');
            import('./cli.js').catch(err => {
                console.error('Failed to start CLI:', err.message);
                process.exit(1);
            });
            break;
            
        case '2':
        case 'web':
        case 'server':
            console.log('\nStarting Web Server...\n');
            import('./server.js').catch(err => {
                console.error('Failed to start server:', err.message);
                process.exit(1);
            });
            break;
            
        default:
            console.log('\n[ERROR] Invalid choice. Please run again.\n');
            process.exit(1);
    }
});
