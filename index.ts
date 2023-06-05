import express, { Express, NextFunction, Request, Response} from 'express';
import { createClient, RedisClientType } from 'redis';
import * as UUID from 'uuid';

import { err, isError, ServerError } from './shytl-data/error';
import { createGameFromId, parseGame, Game } from './shytl-data/game';
import { parseUser, User } from './shytl-data/user';
import { update, Event } from './shytl-data/update';

const app: Express = express();
const port = 8080;

const KEY_TO_USERID_MAP = "key-to-userid";
const USERID_TO_KEY_MAP = "userid-to-key";
const GAMES = "games";

type SHYTLRequest = Request & {
    redis?: RedisClientType,
    game?: Game,
    player?: User
}

// UTILITY FUNCTIONS

async function removePlayer(redis: RedisClientType, game: Game, player: User, userKey: string): Promise<Game> {
    const updatedGame = update(game, { type: "Event", eventType: "RemovePlayer", event: { playerID: player.id }});

    if (isError(updatedGame))
        throw updatedGame;

    await redis.multi()
        .hSet(GAMES, updatedGame.id, JSON.stringify(updatedGame))
        .hDel(KEY_TO_USERID_MAP, userKey)
        .hDel(USERID_TO_KEY_MAP, player.id)
        .exec();
 
    return updatedGame;
}

async function updateGame(redis: RedisClientType, game: Game, event: Event): Promise<Game> {
    const updatedGame = update(game, event);

    if (isError(updatedGame))
        throw updatedGame;

    await redis.hSet(GAMES, updatedGame.id, JSON.stringify(updatedGame));

    return updatedGame;
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await handler(req, res, next);
        } catch (e) {
            next(e);
        }
    }
}

// MIDDLEWARE

function errorMiddleware(error: any, req: Request, res: Response, next: NextFunction) {
    res.status(500).json(isError(error)
        ? error
        : err<ServerError>("ServerError", error)
    );
}

const redisMiddleware = asyncHandler(async (req: SHYTLRequest, res: Response, next: NextFunction) => {
    const redis: RedisClientType = await createClient({ url: 'redis://localhost:2187'});
    await redis.connect();

    req.redis = redis;
    
    next();
});

const gameMiddleware = [redisMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response, next: NextFunction) => {
    const redis = req.redis;
    const gameId = req.params.gameId;

    if (typeof gameId !== "string")
        throw "Invalid Game ID: " + JSON.stringify(gameId);

    const gameResult = await redis?.hGet(GAMES, gameId);
    if (!gameResult)
        throw "No game with ID " + gameId;

    const game = parseGame(JSON.parse(gameResult));

    if (isError(game))
        throw game;

    req.game = game;
    next();
})];

const authMiddleware = [...gameMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response, next: NextFunction) => {
    const redis = req.redis;
    const game = req.game;

    const userKey = req.query.key;

    if (typeof userKey !== "string")
        throw "Invalid user key: " + userKey;

    const userResult = await redis?.hGet(KEY_TO_USERID_MAP, userKey);
    if (!userResult)
        throw "No user with key " + userKey;

    const user = game?.players?.filter(p => p.id == userResult)[0];

    if (!user)
        throw "You are not a part of this game.";

    req.player = user;
    next();
})];

// ROUTEs

app.get('/api/newGame', redisMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    const name = req.query.name;

    if (typeof name !== "string")
        throw "Invalid user name: " + JSON.stringify(name);
   
    const user: User = { id: UUID.v4(), name };
    let newGame = update(createGameFromId(UUID.v4()), { type: "Event", eventType: "AddPlayer", event: { player: user }});

    if (isError(newGame))
        throw newGame.error;

    const userKey = UUID.v4();

    await req.redis?.multi()
        .hSet(KEY_TO_USERID_MAP, userKey, user.id)
        .hSet(USERID_TO_KEY_MAP, user.id, userKey)
        .hSet(GAMES, newGame.id, JSON.stringify(newGame))
        .exec();

    res.json({ game: newGame, key: userKey });
}));

app.get('/api/game/:gameId', authMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    res.json({ game: req.game });
}));

app.get('/api/game/:gameId/join', gameMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    const name = req.query.name;

    if (typeof name !== "string")
        throw "Invalid user name: " + JSON.stringify(name);

    const userKey = UUID.v4();
    const userID = UUID.v4();

    const updatedGame = req.game && update(req.game, { type: "Event", eventType: "AddPlayer", event: { player: { id: userID, name } }});

    if (!updatedGame)
        throw "Could not find game.";
    if (isError(updatedGame))
        throw updatedGame;

    await req.redis?.multi()
        .hSet(GAMES, updatedGame.id, JSON.stringify(updatedGame))
        .hSet(KEY_TO_USERID_MAP, userKey, userID)
        .hSet(USERID_TO_KEY_MAP, userID, userKey)
        .exec();

    res.json({ game: updatedGame, key: userKey });
}));

app.get('/api/game/:gameId/leave', authMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    const game = req.game as Game;
    const player = req.player as User;
    const userKey = req.query.key as string;
    const redis = req.redis as RedisClientType;

    await removePlayer(redis, game, player, userKey);

    res.json({ });
}));

app.get('/api/game:gameId/kick', authMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    const { game, player, redis } = req;

    const kickId = req.query.kickId;
    if (typeof kickId != "string")
        throw "Not a valid User ID: " + JSON.stringify(kickId);
    
    if (player?.id != kickId && player?.id != game?.players[0]?.id)
        throw "You do not have permission to kick that user.";

    const kickPlayer = game?.players.filter(p => p.id == kickId)[0];
    const kickKey = await redis?.hGet(USERID_TO_KEY_MAP, kickId);

    if (!kickPlayer || !kickKey)
        throw "The player you are trying to kick is not in the game.";

    const updatedGame = await removePlayer(redis as RedisClientType, game, kickPlayer, kickId);

    res.json({ game: updatedGame });
}));

app.get('/api/game/:gameId/draw', authMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    const { game, player, redis } = req;

    const isCurrentPlayer = (game?.currentAnswerer === null && player?.id == game?.players[0]?.id)      // the current answerer or, if there is none, the host can draw the next card
        || (game?.currentAnswerer !== null && game?.players[game?.currentAnswerer].id == player?.id);

    if (!isCurrentPlayer)
        throw "It's not your turn!";

    const updatedGame = await updateGame(redis as RedisClientType, game as Game, { type: "Event", eventType: "DrawCard" });
    res.json({ game: updatedGame });
}));

app.get('/api/game/:gameId/skip', authMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    const { game, player, redis } = req;

    const isCurrentPlayer = game?.currentAnswerer !== null && game?.players[game?.currentAnswerer].id == player?.id;
    if (!isCurrentPlayer)
        throw "It's not your turn!";

    const updatedGame = await updateGame(redis as RedisClientType, game as Game, { type: "Event", eventType: "DrawCard" });
    res.json({ game: updatedGame });
}));

app.get('/api/game/:gameId/jumpToLevel/:level', authMiddleware, asyncHandler(async (req: SHYTLRequest, res: Response) => {
    const { game, player, redis } = req;
    const level = parseInt(req.params.level);

    if (level !== 1 && level !== 2 && level !== 3 && level !== 4)
        throw "Not a valid level: " + JSON.stringify(level);

    const isHost = game?.players[0]?.id === player?.id;
    if (!isHost)
        throw "Only the game host can change levels.";

    const updatedGame = await updateGame(redis as RedisClientType, game as Game, { type: "Event", eventType: "JumpToLevel", event: { level }});
    res.json({ game: updatedGame });
}));

app.use(errorMiddleware);

app.listen(port, () => { 
    console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});