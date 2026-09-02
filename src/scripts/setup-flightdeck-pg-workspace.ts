import { closeDb } from '../db';
import { setupFlightDeckPgDevWorkspace, type FlightDeckPgSetupInput } from '../services/flightdeck-pg-setup';

const DEFAULT_CHANNELS = ['Flight Deck PG', 'Tower PG', 'Implementation'];

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = Bun.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = Bun.argv.indexOf(`--${name}`);
  if (index >= 0) return Bun.argv[index + 1];
  return undefined;
}

function readChannels(): string[] {
  const raw = readArg('channels') || process.env.FD_PG_CHANNELS;
  if (!raw) return DEFAULT_CHANNELS;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function inputFromArgs(): FlightDeckPgSetupInput {
  const creatorNpub = readArg('creator-npub') || process.env.FD_PG_CREATOR_NPUB;
  if (!creatorNpub) throw new Error('Missing required --creator-npub (or FD_PG_CREATOR_NPUB)');
  const secondActorNpub = readArg('second-actor-npub') || process.env.FD_PG_SECOND_ACTOR_NPUB;
  const secondActorDisplayName = readArg('second-actor-display-name') || process.env.FD_PG_SECOND_ACTOR_DISPLAY_NAME;
  if (secondActorNpub && !secondActorDisplayName) {
    throw new Error('--second-actor-display-name is required when --second-actor-npub is set');
  }
  if (!secondActorNpub && secondActorDisplayName) {
    throw new Error('--second-actor-npub is required when --second-actor-display-name is set');
  }
  return {
    towerServiceNpub: readArg('tower-service-npub') || process.env.FD_PG_TOWER_SERVICE_NPUB,
    workspaceServiceNpub: readArg('workspace-service-npub') || process.env.FD_PG_WORKSPACE_SERVICE_NPUB || '',
    workspaceOwnerNpub: readArg('workspace-owner-npub') || process.env.FD_PG_WORKSPACE_OWNER_NPUB || creatorNpub,
    appNpub: readArg('app-npub') || process.env.FD_PG_APP_NPUB,
    creatorNpub,
    creatorDisplayName: readArg('creator-display-name') || process.env.FD_PG_CREATOR_DISPLAY_NAME || 'Workspace Creator',
    workspaceName: readArg('workspace-name') || process.env.FD_PG_WORKSPACE_NAME || 'Flight Deck PG',
    workspaceDescription: readArg('workspace-description') || process.env.FD_PG_WORKSPACE_DESCRIPTION || 'Flight Deck PG development workspace',
    smokeScopeName: readArg('smoke-scope-name') || process.env.FD_PG_SMOKE_SCOPE_NAME || 'Wingman Suite',
    smokeChannelName: readArg('smoke-channel-name') || process.env.FD_PG_SMOKE_CHANNEL_NAME || DEFAULT_CHANNELS[0],
    channelNames: readChannels(),
    secondActorNpub,
    secondActorDisplayName,
    secondActorKind: 'agent',
    secondActorRole: 'agent',
    secondActorGroupName: 'Agents',
    towerBaseUrl: readArg('tower-base-url') || process.env.FD_PG_TOWER_BASE_URL,
  };
}

async function main() {
  const result = await setupFlightDeckPgDevWorkspace(inputFromArgs());
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
