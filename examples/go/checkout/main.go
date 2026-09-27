// Command checkout buys the last unit of stock. Unsafe: the stock check and the
// update are separate statements.
package main

import (
	"context"
	"encoding/json"
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

	var stock int
	if err := conn.QueryRow(ctx, "SELECT stock FROM product WHERE id = $1", 1).Scan(&stock); err != nil {
		log.Fatal(err)
	}
	if stock > 0 {
		if _, err := conn.Exec(ctx, "UPDATE product SET stock = $1 WHERE id = $2", stock-1, 1); err != nil {
			log.Fatal(err)
		}
		if _, err := conn.Exec(ctx, "INSERT INTO orders (product_id) VALUES ($1)", 1); err != nil {
			log.Fatal(err)
		}
	}
	result := struct {
		SawStock int  `json:"saw_stock"`
		Bought   bool `json:"bought"`
	}{stock, stock > 0}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		log.Fatal(err)
	}
}
