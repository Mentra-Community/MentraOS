#!/usr/bin/env python3
"""
Simple MongoDB connection test script.
Tests connection to MongoDB Atlas and displays database information.
"""

from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError
import sys

# MongoDB connection string
MONGO_URI = "mongodb+srv://readWrite:readWritePw@sisu.zbkrgfu.mongodb.net/?appName=sisu"

def test_connection():
    """Test MongoDB connection and display information."""
    print("=" * 60)
    print("MongoDB Connection Test")
    print("=" * 60)
    print(f"\nConnecting to: {MONGO_URI.split('@')[1].split('/')[0]}")
    print("(credentials hidden for security)\n")

    try:
        # Create MongoDB client with a 5-second timeout
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)

        # Test the connection
        print("Testing connection...")
        client.admin.command('ping')
        print("✅ Successfully connected to MongoDB!\n")

        # Get server info
        server_info = client.server_info()
        print(f"MongoDB Version: {server_info.get('version', 'Unknown')}")

        # List databases
        print("\nAvailable Databases:")
        databases = client.list_database_names()
        for db_name in databases:
            db = client[db_name]
            collections = db.list_collection_names()
            print(f"  • {db_name}")
            if collections:
                print(f"    Collections: {', '.join(collections[:5])}")
                if len(collections) > 5:
                    print(f"    ... and {len(collections) - 5} more")
            else:
                print(f"    (no collections)")

        # Connection string for .env file
        print("\n" + "=" * 60)
        print("Add this to your .env file:")
        print("=" * 60)
        print(f"MONGO_URL={MONGO_URI}")
        print("=" * 60)

        # Close connection
        client.close()
        print("\n✅ Connection test completed successfully!")
        return 0

    except ConnectionFailure as e:
        print(f"❌ Connection failed: {e}")
        print("\nPossible issues:")
        print("  • Check if the credentials are correct")
        print("  • Verify network connectivity")
        print("  • Ensure MongoDB Atlas allows your IP address")
        return 1

    except ServerSelectionTimeoutError as e:
        print(f"❌ Server selection timeout: {e}")
        print("\nPossible issues:")
        print("  • MongoDB server might be down")
        print("  • Network connectivity issues")
        print("  • Firewall blocking the connection")
        print("  • IP whitelist in MongoDB Atlas")
        return 1

    except Exception as e:
        print(f"❌ Unexpected error: {type(e).__name__}: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(test_connection())
