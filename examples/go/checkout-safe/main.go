// Command checkout-safe buys the last unit of stock. Safe: one conditional
// update decides whether the purchase happens.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"

	"github.com/jackc/pgx/v5"
)

func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close(ctx)

	tx, err := conn.Begin(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer tx.Rollback(ctx) // No effect after Commit.

	var remaining int
	err = tx.QueryRow(ctx, "UPDATE product SET stock = stock - 1 WHERE id = $1 AND stock > 0 RETURNING stock", 1).Scan(&remaining)
	bought := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		log.Fatal(err)
	}
	if bought {
		if _, err := tx.Exec(ctx, "INSERT INTO orders (product_id) VALUES ($1)", 1); err != nil {
			log.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		log.Fatal(err)
	}
	result := struct {
		Bought bool `json:"bought"`
	}{bought}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		log.Fatal(err)
	}
}
