package cli

import (
	"context"

	"github.com/nanobot-ai/nanobot/pkg/mcp"
	"github.com/nanobot-ai/nanobot/pkg/types"
)

func withTempSession(ctx context.Context, cfg *types.Config, env map[string]string) context.Context {
	session := mcp.NewEmptySession(ctx)
	session.Set(types.ConfigSessionKey, cfg)
	if env != nil {
		session.AddEnv(env)
	}
	return mcp.WithSession(ctx, session)
}
