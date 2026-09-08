import { getUserByUsername, getUnassignedCounts, assignUnassignedToUser } from '../db.js';

function printHelp() {
  console.log(`
MediaVault - Administrative Legacy Library Claim Tool
-----------------------------------------------------
Usage:
  node scripts/claim-legacy.js <username>
  npm run claim-legacy <username>

Example:
  node scripts/claim-legacy.js matil
`);
}

async function main() {
  const targetUsername = process.argv[2];

  if (!targetUsername || targetUsername.trim() === '' || targetUsername.startsWith('-')) {
    console.error('❌ Error: Target username is required.');
    printHelp();
    process.exit(1);
  }

  const username = targetUsername.trim();
  const user = getUserByUsername(username);

  if (!user) {
    console.error(`❌ Error: User "${username}" not found in database.`);
    console.error(`   Please register the account "${username}" first via the web app or API before claiming records.`);
    process.exit(1);
  }

  const unassigned = getUnassignedCounts();

  console.log(`\n📦 Checking for unassigned legacy records...`);
  console.log(`   - Unassigned Media (Movies/Series): ${unassigned.mediaCount}`);
  console.log(`   - Unassigned Books: ${unassigned.booksCount}`);
  console.log(`   - Total Unassigned Items: ${unassigned.total}`);

  if (unassigned.total === 0) {
    console.log(`\n✨ No unassigned legacy records remain. All records belong to registered users.`);
    process.exit(0);
  }

  console.log(`\n⏳ Assigning ${unassigned.total} legacy records to user "${user.username}" (ID: ${user.id})...`);
  const result = assignUnassignedToUser(user.id);

  console.log(`\n✅ Success!`);
  console.log(`   - Media items claimed: ${result.mediaAssigned}`);
  console.log(`   - Books claimed: ${result.booksAssigned}`);
  console.log(`   - Total items assigned to "${user.username}": ${result.totalAssigned}\n`);
}

main().catch(err => {
  console.error('❌ Fatal error during legacy claim:', err.message);
  process.exit(1);
});
